// Launches the HOODS sale and buys and burns in the same transaction.
//
// The pool opens shallow, so the first buy against it takes a large share of the supply. This
// script closes that window: it sends ONE EIP-7702 transaction from the sale owner's own wallet
// that calls presale.finalize() and then token.openingBuyBurn() with the owner's ETH. Nothing can
// be sequenced between the two, because they are the same transaction.
//
// EIP-7702 lets an ordinary wallet run a contract's code for one transaction without becoming a
// contract. The code it runs is LaunchBatch, which only forwards calls and only when the wallet
// calls itself. The delegation is revoked in the same run unless KEEP_DELEGATION=1.
//
//   DEPLOYER_KEY=0x... OPENING_ETH=5 npx hardhat run scripts/launch-hoods.js --network robinhood
//
// Environment:
//   OPENING_ETH=<eth>     ETH to offer to the opening buy (default 0: launch with no buy)
//   PRESALE=0x...         the sale to launch (default: the HOODS sale in deployments)
//   LAUNCH_BATCH=0x...    reuse an already deployed LaunchBatch instead of deploying one
//   SLIPPAGE_BPS=<n>      how far below the intended liquidity finalize may land (default 100)
//   KEEP_DELEGATION=1     leave the wallet delegated to LaunchBatch afterwards
//   DRY_RUN=1             check and simulate everything, send no launch transaction
//
// The script refuses to run unless the sale is finalizable, the signer owns it, and the token
// carries openingBuyBurn. A revert anywhere rolls the whole launch back and the sale stays
// finalizable, so a failed attempt costs gas and nothing else.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { sendSelfBatch, revokeSelfDelegation } = require("./lib/eip7702");

const BPS = 10_000n;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const STATE = ["Upcoming", "Live", "Ended", "Failed", "Cancelled", "Finalized"];

async function main() {
  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("no signer: set DEPLOYER_KEY");
  const E = (x) => hre.ethers.formatEther(x);
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  const openingEth = hre.ethers.parseEther(process.env.OPENING_ETH || "0");
  const slippageBps = BigInt(process.env.SLIPPAGE_BPS || "100");
  const dryRun = process.env.DRY_RUN === "1";

  // ---------------------------------------------------------------- the sale
  const saleAddr = process.env.PRESALE || d.hoodsalePresale;
  if (!saleAddr) throw new Error("set PRESALE, or record hoodsalePresale in the deployment file");
  const sale = await hre.ethers.getContractAt("Presale", saleAddr);
  const p = await sale.getParams();
  const owner = await sale.saleOwner();
  const raised = await sale.totalRaised();
  const state = Number(await sale.status());

  console.log(`Launching ${saleAddr} on ${network}`);
  console.log(`  state         ${STATE[state] || state}`);
  console.log(`  raised        ${E(raised)} of ${E(p.hardCap)} ETH`);
  console.log(`  owner         ${owner}`);
  console.log(`  token         ${p.token}`);

  if (!same(owner, signer.address)) throw new Error(`the signer must be the sale owner (owner is ${owner})`);
  if (!(await sale.isReadyToFinalize())) {
    throw new Error("the chain will not accept finalize yet: the sale is not ready");
  }

  // What the liquidity add is meant to put in, so finalize is not left with a loose 5% default.
  const platformFeeBps = BigInt(await sale.platformFeeBps());
  const netEth = raised - (raised * platformFeeBps) / BPS;
  const liquidityEth = (netEth * BigInt(p.liquidityBps)) / BPS;
  const liquidityTokens = (liquidityEth * p.listingRate) / 10n ** 18n;
  const minTokens = (liquidityTokens * (BPS - slippageBps)) / BPS;
  const minEth = (liquidityEth * (BPS - slippageBps)) / BPS;
  console.log(`  liquidity     ${E(liquidityEth)} ETH and ${E(liquidityTokens)} tokens`);
  console.log(`  minimums      ${E(minEth)} ETH and ${E(minTokens)} tokens (${Number(slippageBps) / 100}% slack)`);

  // ---------------------------------------------------------------- the token
  const token = await hre.ethers.getContractAt("HoodSaleToken", p.token);
  if (openingEth > 0n) {
    try {
      if (await token.openingDone()) throw new Error("this token's opening buy has already run");
      if ((await token.poolOpenedBlock()) !== 0n) {
        throw new Error("the pool was opened in an earlier block; the opening buy can no longer run");
      }
    } catch (e) {
      if (String(e.message).includes("already run") || String(e.message).includes("earlier block")) throw e;
      throw new Error(`${p.token} does not carry openingBuyBurn; deploy the current token first`);
    }
    const balance = await hre.ethers.provider.getBalance(signer.address);
    if (balance < openingEth) {
      throw new Error(`not enough ETH for the opening buy: have ${E(balance)}, offering ${E(openingEth)}`);
    }
    console.log(`  opening buy   offering ${E(openingEth)} ETH, capped at 150% of the pool's ETH reserve`);
  } else {
    console.log("  opening buy   none (set OPENING_ETH to fund one)");
  }

  // ---------------------------------------------------------------- the batch code
  let batchAddr = process.env.LAUNCH_BATCH;
  if (batchAddr) {
    if (!hre.ethers.isAddress(batchAddr)) throw new Error(`LAUNCH_BATCH is not an address: ${batchAddr}`);
    if ((await hre.ethers.provider.getCode(batchAddr)) === "0x") {
      throw new Error(`LAUNCH_BATCH has no code on ${network}: ${batchAddr}`);
    }
    console.log(`  batch code    reusing ${batchAddr}`);
  } else if (openingEth > 0n) {
    if (dryRun) {
      console.log("  batch code    would be deployed (DRY_RUN)");
      batchAddr = hre.ethers.ZeroAddress;
    } else {
      const batch = await hre.ethers.deployContract("LaunchBatch");
      await batch.waitForDeployment();
      batchAddr = batch.target;
      console.log(`  batch code    deployed ${batchAddr}`);
    }
  }

  const saleIface = sale.interface;
  const tokenIface = token.interface;
  const calls = [
    { to: saleAddr, value: 0n, data: saleIface.encodeFunctionData("finalize", [minTokens, minEth]) },
  ];
  if (openingEth > 0n) {
    calls.push({ to: p.token, value: openingEth, data: tokenIface.encodeFunctionData("openingBuyBurn") });
  }

  if (openingEth === 0n) {
    // Nothing to batch: a plain finalize is the whole launch.
    if (dryRun) {
      await sale.finalize.staticCall(minTokens, minEth);
      console.log("\nDRY_RUN: finalize simulates cleanly. Nothing was sent.");
      return;
    }
    const tx = await sale.finalize(minTokens, minEth);
    const rc = await tx.wait();
    console.log(`\nLaunched in ${rc.hash}, gas ${rc.gasUsed}`);
    return;
  }

  // ---------------------------------------------------------------- the one transaction
  const batchIface = new hre.ethers.Interface([
    "function run((address to, uint256 value, bytes data)[] calls) external payable",
  ]);
  const data = batchIface.encodeFunctionData("run", [calls.map((c) => [c.to, c.value, c.data])]);

  if (dryRun) {
    console.log("");
    console.log("DRY_RUN: the batch that would be sent, in order");
    calls.forEach((c, i) => console.log(`  ${i + 1}. ${c.to} value ${E(c.value)} ETH  ${c.data.slice(0, 10)}`));
    console.log("");
    console.log("Simulating finalize on its own (the batch itself cannot be simulated before the");
    console.log("delegation exists, and the opening buy needs the pool that finalize creates):");
    await sale.finalize.staticCall(minTokens, minEth);
    console.log("  finalize simulates cleanly. Nothing was sent.");
    return;
  }

  const rpcUrl = hre.network.config.url;
  const gasLimit = BigInt(process.env.GAS_LIMIT || "1500000");
  const { receipt: rc } = await sendSelfBatch({
    rpcUrl,
    privateKey: process.env.DEPLOYER_KEY,
    batchAddress: batchAddr,
    calls,
    value: openingEth,
    gasLimit,
  });

  const burnEvents = await token.queryFilter(token.filters.OpeningBuyBurn(), rc.blockNumber, rc.blockNumber);
  if (burnEvents.length) {
    const ev = burnEvents.at(-1);
    console.log("");
    console.log("Opening buy and burn");
    console.log(`  spent         ${E(ev.args.ethSpent)} ETH`);
    console.log(`  burned        ${E(ev.args.tokensBurned)} HOODS`);
    console.log(`  refunded      ${E(openingEth - ev.args.ethSpent)} ETH`);
    console.log(`  supply now    ${E(await token.totalSupply())} HOODS`);
  } else {
    console.log("");
    console.log("WARNING: the launch went through but no OpeningBuyBurn event was found.");
  }

  if (process.env.KEEP_DELEGATION === "1") {
    console.log("\nKEEP_DELEGATION=1: the wallet is still delegated to LaunchBatch.");
  } else {
    console.log("");
    await revokeSelfDelegation({ rpcUrl, privateKey: process.env.DEPLOYER_KEY });
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
