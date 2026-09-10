// Recreates a presale that has not opened yet, so it carries the current presale code.
//
// A presale is a deployed contract. Changing Presale and running scripts/upgrade-presale-code.js
// only affects sales created from that point on, so a sale that was announced before the change
// has to be cancelled and created again with the same rules. The new sale gets a new address,
// which is why frontend/src/config/presaleRedirects.js exists: the announced link keeps working
// and sends visitors to the replacement.
//
// The script reads the old sale's parameters from the chain and creates the replacement with
// exactly those values, so nothing drifts. It refuses to run unless every one of these holds:
//   - the signer is the sale owner
//   - the sale is still Upcoming, with nothing raised and no contributors
//   - the factory's presale code is the Presale of the current build
//
//   DEPLOYER_KEY=0x... PRESALE=0x... npx hardhat run scripts/recreate-presale.js --network robinhood
//
// Optional environment:
//   START_TIME=<unix>            open the replacement at another time (default: the old schedule)
//   END_TIME=<unix>              close it at another time (default: the old schedule)
//   ALLOW_WHITELIST_RESET=1      proceed although the old sale has whitelist wallets on it. They
//                                are NOT copied: the mapping cannot be read back from the chain,
//                                so they have to be added to the new sale from your own list.
//   DRY_RUN=1                    check everything and print the plan, send no transaction
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const STATE = ["Upcoming", "Live", "Ended", "Failed", "Cancelled", "Finalized"];

async function main() {
  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("no signer: set DEPLOYER_KEY");
  const old = process.env.PRESALE;
  if (!old || !hre.ethers.isAddress(old)) throw new Error("set PRESALE to the sale being replaced");
  const dryRun = process.env.DRY_RUN === "1";

  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!d.presaleFactory) throw new Error(`deployments/${network}.json has no presaleFactory`);

  const factory = await hre.ethers.getContractAt("PresaleFactory", d.presaleFactory);
  const sale = await hre.ethers.getContractAt("Presale", old);

  const E = (x) => hre.ethers.formatEther(x);
  const p = await sale.getParams();
  const state = Number(await sale.status()) === 0 ? 0 : Number(await sale.status());
  const raised = await sale.totalRaised();
  const contributors = await sale.contributorCount();
  const owner = await sale.saleOwner();
  const wlOn = await sale.whitelistEnabled();
  const wlCount = await sale.whitelistCount();

  console.log(`Replacing sale ${old} on ${network}`);
  console.log(`  state         ${STATE[state] || state}`);
  console.log(`  raised        ${E(raised)} ETH from ${contributors} contributors`);
  console.log(`  owner         ${owner}`);
  console.log(`  token         ${p.token}`);
  console.log(`  caps          soft ${E(p.softCap)} ETH, hard ${E(p.hardCap)} ETH`);
  console.log(`  per wallet    ${E(p.minContribution)} to ${E(p.maxContribution)} ETH`);
  console.log(`  rates         presale ${E(p.presaleRate)}, listing ${E(p.listingRate)} per ETH`);
  console.log(`  liquidity     ${Number(p.liquidityBps) / 100}%, ${Number(p.liquidityAction) === 1 ? "burned" : "locked"}`);
  console.log(`  schedule      ${new Date(Number(p.startTime) * 1000).toISOString()} to ${new Date(Number(p.endTime) * 1000).toISOString()}`);
  console.log(`  whitelist     ${wlOn ? "on" : "off"}, ${wlCount} wallets`);

  if (!same(owner, signer.address)) throw new Error(`the signer must be the sale owner (owner is ${owner})`);
  if (state !== 0) throw new Error(`only a sale that has not opened can be replaced (state is ${STATE[state] || state})`);
  if (raised > 0n || contributors > 0n) {
    throw new Error("this sale has taken money; it must keep its own page so contributors can claim or refund");
  }
  if (wlCount > 0n && process.env.ALLOW_WHITELIST_RESET !== "1") {
    throw new Error(
      `the old sale has ${wlCount} whitelist wallets and they cannot be read back from the chain. ` +
        "Re-run with ALLOW_WHITELIST_RESET=1 and add them to the new sale from your own list."
    );
  }

  // The point of the exercise: the factory has to be on the presale code of this build, or the
  // replacement would be created from the same code as the sale being replaced.
  const codeHolder = await factory.presaleCode();
  const holder = await hre.ethers.getContractAt("PresaleCode", codeHolder);
  const artifact = await hre.artifacts.readArtifact("Presale");
  if ((await holder.creationCode()).toLowerCase() !== artifact.bytecode.toLowerCase()) {
    throw new Error(
      `the factory's presale code ${codeHolder} is not the Presale of this build. ` +
        "Run scripts/upgrade-presale-code.js first."
    );
  }
  console.log(`  presale code  ${codeHolder} (the Presale of this build)`);

  const startTime = process.env.START_TIME ? BigInt(process.env.START_TIME) : p.startTime;
  const endTime = process.env.END_TIME ? BigInt(process.env.END_TIME) : p.endTime;
  const now = BigInt((await hre.ethers.provider.getBlock("latest")).timestamp);
  if (startTime <= now) throw new Error(`the new start time is not in the future (${startTime} <= ${now})`);
  if (endTime <= startTime) throw new Error("the new end time is not after the start time");

  const next = {
    token: p.token,
    presaleRate: p.presaleRate,
    listingRate: p.listingRate,
    softCap: p.softCap,
    hardCap: p.hardCap,
    minContribution: p.minContribution,
    maxContribution: p.maxContribution,
    startTime,
    endTime,
    liquidityBps: p.liquidityBps,
    liquidityAction: p.liquidityAction,
    lockDuration: p.lockDuration,
    launchTime: p.launchTime,
    whitelistEnabled: p.whitelistEnabled,
  };
  const required = await factory.requiredTokensFor(next);
  const fee = await factory.creationFee();
  console.log(`  needs         ${E(required)} tokens and ${E(fee)} ETH to create the replacement`);

  if (dryRun) {
    console.log("");
    console.log("DRY_RUN: nothing was sent. Without it the script would cancel the sale, which returns");
    console.log("its tokens to you, then approve the factory and create the replacement.");
    return;
  }

  console.log("");
  console.log("Cancelling the old sale (its tokens come back to you)");
  await (await sale.cancel()).wait();
  console.log(`  ${old} is Cancelled`);

  const token = await hre.ethers.getContractAt("StandardToken", p.token);
  const balance = await token.balanceOf(signer.address);
  if (balance < required) {
    throw new Error(`not enough tokens to create the replacement: have ${E(balance)}, need ${E(required)}`);
  }
  await (await token.approve(factory.target, required)).wait();
  await (await factory.createPresale(next, { value: fee })).wait();
  const created = await factory.allPresales((await factory.allPresalesLength()) - 1n);
  console.log(`Created ${created}`);

  const replacement = await hre.ethers.getContractAt("Presale", created);
  console.log("");
  console.log("The replacement");
  console.log(`  address       ${created}`);
  console.log(`  state         ${STATE[Number(await replacement.status())]}`);
  console.log(`  raised        ${E(await replacement.totalRaised())} ETH`);
  console.log(`  whitelist     ${(await replacement.whitelistEnabled()) ? "on" : "off"}, ${await replacement.whitelistCount()} wallets`);
  console.log(`  schedule      ${new Date(Number(startTime) * 1000).toISOString()} to ${new Date(Number(endTime) * 1000).toISOString()}`);

  const steps = [];
  steps.push(
    "Keep the announced link working. In frontend/src/config/presaleRedirects.js, under\n" +
      `     the chain id ${(await hre.ethers.provider.getNetwork()).chainId}, add\n` +
      `       '${old}': '${created}',\n` +
      "     then build and deploy the site."
  );
  if (wlCount > 0n) {
    steps.push(`Add the ${wlCount} whitelist wallets to the new sale from your own list.`);
  } else if (p.whitelistEnabled) {
    steps.push("Add the whitelist wallets to the new sale when the applications close.");
  }
  steps.push("Set the sale profile and description on the new page.");
  console.log("");
  console.log("Next");
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
