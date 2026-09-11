// Sends an EIP-7702 batch from a wallet to itself, correctly, on a Nitro chain.
//
// Two things here are not obvious and both were learned the hard way on mainnet.
//
// 1. The authorization nonce. When the account signing the authorization is also the account
//    sending the transaction, the sender's nonce is bumped before the authorization list is
//    processed, so the authorization has to carry nonce + 1. ethers' signer.authorize() fills in
//    the CURRENT nonce, which is right for delegating some other account and wrong for this. An
//    authorization whose nonce does not match is not an error: it is skipped, the transaction
//    succeeds, and nothing happens. A mainnet attempt cost a transaction that did exactly that.
//
// 2. The transport. Going through a JSON-RPC eth_sendTransaction serializes the authorization's
//    r and s as fixed 32-byte hex, and a Go node rejects any quantity with a leading zero digit
//    ("cannot unmarshal hex number with leading zero digits"), which happens for roughly one
//    signature in sixteen. Signing locally and sending the raw bytes avoids the JSON entirely.
const { ethers } = require("ethers");

const BATCH_ABI = ["function run((address to, uint256 value, bytes data)[] calls) external payable"];

/** A provider and wallet that bypass the hardhat provider, for the raw send above. */
function walletFor(rpcUrl, privateKey) {
  if (!privateKey) throw new Error("no private key: set DEPLOYER_KEY");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return { provider, wallet: new ethers.Wallet(privateKey, provider) };
}

async function feeFor(provider) {
  const fee = await provider.getFeeData();
  const base = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits("0.5", "gwei");
  return {
    maxFeePerGas: (base * 3n) / 2n,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n,
  };
}

/**
 * Runs `calls` in order, in one transaction, with the wallet temporarily running `batchAddress`.
 * Returns the receipt. Throws when the delegation did not take: a transaction that succeeds
 * without the batch running is the failure mode this exists to catch.
 */
async function sendSelfBatch({ rpcUrl, privateKey, batchAddress, calls, value = 0n, gasLimit = 1_500_000n, log = console.log }) {
  const { provider, wallet } = walletFor(rpcUrl, privateKey);
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const nonce = await provider.getTransactionCount(wallet.address, "pending");

  // nonce + 1: see the note at the top of this file.
  const auth = await wallet.authorize({ address: batchAddress, nonce: nonce + 1, chainId });
  const data = new ethers.Interface(BATCH_ABI).encodeFunctionData("run", [
    calls.map((c) => [c.to, c.value ?? 0n, c.data ?? "0x"]),
  ]);
  const fees = await feeFor(provider);

  const signed = await wallet.signTransaction({
    type: 4,
    chainId,
    nonce,
    to: wallet.address,
    data,
    value,
    gasLimit,
    ...fees,
    authorizationList: [auth],
  });
  const hash = await provider.send("eth_sendRawTransaction", [signed]);
  log(`  sent          ${hash}`);
  const receipt = await provider.waitForTransaction(hash);
  log(`  mined         block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);

  if (receipt.status !== 1) throw new Error(`the launch transaction reverted: ${hash}`);
  // A self-call with calldata but no delegation costs about 49k. Anything the batch actually did
  // costs far more, so this separates "it ran" from "the authorization was skipped".
  if (receipt.gasUsed < 100_000n) {
    throw new Error(
      `the transaction went through but the batch did not run (gas ${receipt.gasUsed}). The ` +
        "authorization was skipped, so nothing was called and nothing was spent. Nothing is lost; " +
        "check the delegation nonce before retrying."
    );
  }
  return { receipt, provider, wallet };
}

/** Puts the wallet back to being an ordinary wallet. */
async function revokeSelfDelegation({ rpcUrl, privateKey, gasLimit = 100_000n, log = console.log }) {
  const { provider, wallet } = walletFor(rpcUrl, privateKey);
  const chainId = Number((await provider.getNetwork()).chainId);
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const auth = await wallet.authorize({ address: ethers.ZeroAddress, nonce: nonce + 1, chainId });
  const fees = await feeFor(provider);
  const signed = await wallet.signTransaction({
    type: 4,
    chainId,
    nonce,
    to: wallet.address,
    data: "0x",
    value: 0,
    gasLimit,
    ...fees,
    authorizationList: [auth],
  });
  const hash = await provider.send("eth_sendRawTransaction", [signed]);
  await provider.waitForTransaction(hash);
  const code = await provider.getCode(wallet.address);
  log(`  delegation revoked in ${hash}; wallet code is now ${code === "0x" ? "empty" : code}`);
  return code === "0x";
}

module.exports = { sendSelfBatch, revokeSelfDelegation, walletFor, BATCH_ABI };
