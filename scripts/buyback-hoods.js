// Spends the Treasury's buyback reserve on HOODS and sends it to the dead address.
//
// Treasury.executeBuyback is owner only and takes a floor for the tokens it must receive. This
// script quotes the swap against the live pool, applies a slippage allowance to that quote,
// simulates the call from the owner, and only then sends it. The buyer is the dead address,
// which the token exempts from its tax, so the router quote is exactly what the swap returns.
//
//   DRY_RUN=1 npx hardhat run scripts/buyback-hoods.js --network robinhood
//   DEPLOYER_KEY=0x... npx hardhat run scripts/buyback-hoods.js --network robinhood
//
// Environment:
//   ETH=<amount>        ETH to spend (default: the whole reserve)
//   SLIPPAGE_BPS=<n>    how far below the quote the swap may land (default 300)
//   DRY_RUN=1           quote and simulate from the owner, send nothing; needs no key
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const BPS = 10_000n;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function main() {
  const { ethers } = hre;
  const E = (x) => ethers.formatEther(x);
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const dryRun = process.env.DRY_RUN === "1";
  const slippageBps = BigInt(process.env.SLIPPAGE_BPS || "300");

  const treasury = await ethers.getContractAt("Treasury", d.treasury);
  const [owner, reserve, routerAddr, hoods] = await Promise.all([
    treasury.owner(), treasury.buybackReserve(), treasury.router(), treasury.hoodsale(),
  ]);
  if (routerAddr === ethers.ZeroAddress || hoods === ethers.ZeroAddress) throw new Error("the Treasury is not configured");

  const amount = process.env.ETH ? ethers.parseEther(process.env.ETH) : reserve;
  if (amount === 0n) throw new Error("the buyback reserve is empty");
  if (amount > reserve) throw new Error(`asking for ${E(amount)} ETH but the reserve holds ${E(reserve)}`);

  const router = await ethers.getContractAt(
    ["function WETH() view returns (address)", "function getAmountsOut(uint256, address[]) view returns (uint256[])"],
    routerAddr
  );
  const weth = await router.WETH();
  const quote = (await router.getAmountsOut(amount, [weth, hoods]))[1];
  const minOut = (quote * (BPS - slippageBps)) / BPS;
  const token = await ethers.getContractAt("HoodSaleToken", hoods);
  const supply = await token.totalSupply();

  console.log(`Buyback from ${d.treasury} on ${network}`);
  console.log(`  owner         ${owner}`);
  console.log(`  reserve       ${E(reserve)} ETH`);
  console.log(`  spending      ${E(amount)} ETH`);
  console.log(`  quote         ${E(quote)} HOODS (${((Number(quote) / Number(supply)) * 100).toFixed(4)}% of supply)`);
  console.log(`  floor         ${E(minOut)} HOODS (${Number(slippageBps) / 100}% slack)`);

  // The simulation runs as the owner, so it proves the call would pass without holding the key.
  await treasury.executeBuyback.staticCall(amount, minOut, { from: owner });
  console.log("  simulation    passes as the owner");

  if (dryRun) {
    console.log("\nDRY_RUN: nothing was sent.");
    return;
  }

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("no signer: set DEPLOYER_KEY");
  if (!same(signer.address, owner)) throw new Error(`the signer must be the Treasury owner (owner is ${owner})`);

  const tx = await treasury.connect(signer).executeBuyback(amount, minOut);
  const rc = await tx.wait();
  const ev = rc.logs
    .filter((l) => same(l.address, d.treasury))
    .map((l) => { try { return treasury.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "BuybackExecuted");
  if (!ev) throw new Error(`the transaction ${rc.hash} went through but carried no BuybackExecuted event`);

  const spent = ev.args.ethSpent;
  const bought = ev.args.hoodsaleBurned;
  const shown = (x, digits) => Number(E(x)).toLocaleString("en-US", { maximumFractionDigits: digits });
  console.log("");
  console.log(`Bought back in ${rc.hash}, gas ${rc.gasUsed}`);
  console.log(`  spent         ${E(spent)} ETH`);
  console.log(`  sent to dead  ${E(bought)} HOODS`);
  console.log(`  dead holds    ${E(await token.balanceOf(DEAD))} HOODS`);
  console.log("");
  console.log("For the tweet:");
  console.log(`  ${shown(spent, 3)} ETH from the buyback reserve bought ${shown(bought, 0)} HOODS and sent them to the dead address.`);
  console.log(`  https://robinhoodchain.blockscout.com/tx/${rc.hash}`);
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
