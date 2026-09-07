// Rehearses the HOODS presale on a live chain with a stand-in token, so the real HOODS never
// gets a pool before its launch. HoodSaleRehearsalToken is HoodSaleToken with another name and
// symbol (HOODSR); everything else is the same code: the 3% tax, the swap on sells, the presale
// factory hook and the Treasury deposit.
//
// Step 1, deploy and allowlist (the sale is then created on the site with "paste address"):
//   DEPLOYER_KEY=0x... npx hardhat run scripts/rehearse-hoodsale.js --network robinhood
// Step 2, at any time, print where the rehearsal stands (allowlist, hook, active sale, pool):
//   STATUS=1 npx hardhat run scripts/rehearse-hoodsale.js --network robinhood
// Step 3, when the rehearsal is over, take the token off the allowlist:
//   CLEANUP=1 DEPLOYER_KEY=0x... npx hardhat run scripts/rehearse-hoodsale.js --network robinhood
//
// The token address is kept under hoodsaleRehearsal in deployments/<network>.json; nothing else
// in the file and nothing on the platform changes (treasury.hoodsale stays the real HOODS).
// Optional: REHEARSAL_TOKEN=0x... names the token instead of the file. Nothing here prints or
// stores a private key.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const fmt = (v) => hre.ethers.formatEther(v);

async function main() {
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const key of ["router", "treasury", "presaleFactory", "hoodsale"]) {
    if (!d[key]) throw new Error(`deployments/${network}.json has no ${key}`);
  }
  const presaleFactory = await hre.ethers.getContractAt("PresaleFactory", d.presaleFactory);
  const tokenAddr = process.env.REHEARSAL_TOKEN || d.hoodsaleRehearsal;

  if (process.env.STATUS === "1") {
    if (!tokenAddr) throw new Error("no rehearsal token yet: run without STATUS first");
    const token = await hre.ethers.getContractAt("HoodSaleRehearsalToken", tokenAddr);
    const sale = await presaleFactory.activePresaleOfToken(tokenAddr);
    console.log(`Rehearsal token ${tokenAddr} (${await token.symbol()})`);
    console.log(`  allowlisted        ${await presaleFactory.allowedToken(tokenAddr)}`);
    console.log(`  presaleFactory     ${await token.presaleFactory()}`);
    console.log(`  owner              ${await token.owner()}`);
    console.log(`  active sale        ${sale === hre.ethers.ZeroAddress ? "-" : sale}`);
    if (sale !== hre.ethers.ZeroAddress) {
      const presale = await hre.ethers.getContractAt("Presale", sale);
      console.log(`  sale status        ${await presale.status()} (0 Upcoming, 1 Live, 2 Ended, 3 Failed, 4 Cancelled, 5 Finalized)`);
      console.log(`  raised             ${fmt(await presale.totalRaised())} ETH`);
      console.log(`  sale tax exempt    ${await token.isExcludedFromFees(sale)}`);
    }
    const pair = await hre.ethers.getContractAt("IUniswapV2Pair", await token.mainPair());
    const [r0, r1] = await pair.getReserves();
    const t0 = await pair.token0();
    const [tokenRes, ethRes] = same(t0, tokenAddr) ? [r0, r1] : [r1, r0];
    console.log(`  pool               ${fmt(tokenRes)} HOODSR / ${fmt(ethRes)} ETH${ethRes > 0n ? `, price ${fmt((ethRes * 10n ** 18n) / tokenRes)} ETH per token` : ""}`);
    console.log(`  tax in contract    ${fmt(await token.balanceOf(tokenAddr))} HOODSR (swapped on a sell once above ${fmt(await token.swapThreshold())})`);
    console.log(`  real HOODS         ${d.hoodsale}, treasury.hoodsale ${await (await hre.ethers.getContractAt("Treasury", d.treasury)).hoodsale()}`);
    return;
  }

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("no signer: set DEPLOYER_KEY");
  if (!same(await presaleFactory.owner(), deployer.address)) throw new Error("the deployer must own PresaleFactory");

  if (process.env.CLEANUP === "1") {
    if (!tokenAddr) throw new Error("no rehearsal token to clean up");
    const sale = await presaleFactory.activePresaleOfToken(tokenAddr);
    if (sale !== hre.ethers.ZeroAddress) {
      const status = await (await hre.ethers.getContractAt("Presale", sale)).status();
      if (status <= 2n) console.log(`WARNING: the rehearsal sale ${sale} is still open (status ${status}); it keeps working after the cleanup, only new sales are refused`);
    }
    if (await presaleFactory.allowedToken(tokenAddr)) {
      await (await presaleFactory.setTokenAllowed(tokenAddr, false)).wait();
      console.log(`presaleFactory.allowedToken(${tokenAddr}): set to false`);
    } else {
      console.log(`presaleFactory.allowedToken(${tokenAddr}): already false`);
    }
    const addresses = { ...d };
    delete addresses.hoodsaleRehearsal;
    fs.writeFileSync(file, JSON.stringify(addresses, null, 2));
    console.log(`Removed hoodsaleRehearsal from deployments/${network}.json. The token and its pool stay on chain; nothing points at them.`);
    return;
  }

  if (tokenAddr && (await hre.ethers.provider.getCode(tokenAddr)) !== "0x") {
    console.log(`Rehearsal token already deployed: ${tokenAddr} (CLEANUP=1 to retire it, STATUS=1 to inspect it)`);
    return;
  }
  const marketingWallet = process.env.MARKETING_WALLET || d.marketingWallet || deployer.address;
  console.log(`Deploying HoodSaleRehearsalToken on ${network} with ${deployer.address}`);
  const token = await hre.ethers.deployContract("HoodSaleRehearsalToken", [deployer.address, d.router, d.treasury, marketingWallet]);
  await token.waitForDeployment();
  console.log(`HoodSaleRehearsalToken: deployed ${token.target} (${await token.symbol()}, supply ${fmt(await token.totalSupply())})`);
  await (await token.setPresaleFactory(d.presaleFactory)).wait();
  console.log(`token.presaleFactory: set to ${d.presaleFactory}`);
  await (await presaleFactory.setTokenAllowed(token.target, true)).wait();
  console.log(`presaleFactory.allowedToken(${token.target}): set to true`);
  fs.writeFileSync(file, JSON.stringify({ ...d, hoodsaleRehearsal: token.target }, null, 2));
  console.log(`Saved as hoodsaleRehearsal in deployments/${network}.json`);
  console.log("Next: on the site open Create presale, choose \"paste address\", paste the token address and create the");
  console.log("sale with small caps; STATUS=1 shows the sale, the pool and the tax at any point; CLEANUP=1 retires the token.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
