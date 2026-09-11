// Proves, on the real chain and for a few cents of gas, that the wallet can run a batch under
// EIP-7702 before the launch depends on it.
//
// It delegates the wallet to LaunchBatch for one transaction, forwards two dust transfers back to
// the wallet itself, checks that the forwarding actually happened, and then revokes the delegation
// so the wallet is an ordinary wallet again.
//
//   DEPLOYER_KEY=0x... npx hardhat run scripts/rehearse-7702.js --network robinhood
//
// Environment:
//   LAUNCH_BATCH=0x...   reuse an already deployed LaunchBatch instead of deploying one
//   KEEP_DELEGATION=1    leave the delegation in place (the launch script can then reuse it)
const hre = require("hardhat");

async function main() {
  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("no signer: set DEPLOYER_KEY");
  const E = (x) => hre.ethers.formatEther(x);
  const provider = hre.ethers.provider;

  console.log(`Rehearsing an EIP-7702 batch on ${hre.network.name} with ${signer.address}`);
  const codeBefore = await provider.getCode(signer.address);
  if (codeBefore !== "0x") console.log(`  note          the wallet already carries code: ${codeBefore}`);

  let batchAddr = process.env.LAUNCH_BATCH;
  if (batchAddr) {
    if ((await provider.getCode(batchAddr)) === "0x") throw new Error(`LAUNCH_BATCH has no code: ${batchAddr}`);
    console.log(`  batch code    reusing ${batchAddr}`);
  } else {
    const batch = await hre.ethers.deployContract("LaunchBatch");
    await batch.waitForDeployment();
    batchAddr = batch.target;
    console.log(`  batch code    deployed ${batchAddr}`);
  }

  // Two dust forwards back to the wallet: harmless, and they prove the calls really ran.
  const dust = hre.ethers.parseEther("0.000001");
  const iface = new hre.ethers.Interface([
    "function run((address to, uint256 value, bytes data)[] calls) external payable",
  ]);
  const data = iface.encodeFunctionData("run", [
    [
      [signer.address, dust, "0x"],
      [signer.address, dust, "0x"],
    ],
  ]);

  const auth = await signer.authorize({ address: batchAddr });
  const tx = await signer.sendTransaction({
    to: signer.address,
    data,
    value: dust * 2n,
    authorizationList: [auth],
  });
  console.log(`  sent          ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`  mined         block ${rc.blockNumber}, gas ${rc.gasUsed}`);

  const codeAfter = await provider.getCode(signer.address);
  const delegated = codeAfter.toLowerCase().startsWith("0xef0100");
  console.log(`  wallet code   ${codeAfter === "0x" ? "empty" : codeAfter}`);
  console.log(`  delegation    ${delegated ? "applied" : "NOT APPLIED"}`);

  // A batch that really ran costs far more than a bare transfer. 21000 means the authorization
  // was ignored and the launch must not be attempted this way.
  const forwarded = rc.gasUsed > 30000n;
  console.log(`  forwarding    ${forwarded ? "the calls ran" : "NOTHING RAN (gas is a bare transfer)"}`);

  if (!delegated || !forwarded) {
    throw new Error(
      "EIP-7702 did not take effect on this chain with this wallet. Do NOT launch with the batch; " +
        "launch with scripts/launch-hoods.js and no OPENING_ETH, or buy in a second transaction."
    );
  }

  if (process.env.KEEP_DELEGATION === "1") {
    console.log("\nKEEP_DELEGATION=1: the wallet stays delegated, so the launch can reuse it.");
  } else {
    const revoke = await signer.authorize({ address: hre.ethers.ZeroAddress });
    const rtx = await signer.sendTransaction({ to: signer.address, authorizationList: [revoke] });
    await rtx.wait();
    const code = await provider.getCode(signer.address);
    console.log(`\nDelegation revoked in ${rtx.hash}; wallet code is now ${code === "0x" ? "empty" : code}`);
  }

  console.log("");
  console.log("The batch works on this chain. The launch can be sent as one transaction:");
  console.log("  DEPLOYER_KEY=0x... OPENING_ETH=5 npx hardhat run scripts/launch-hoods.js --network robinhood");
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
