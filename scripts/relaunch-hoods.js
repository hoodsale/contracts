// Moves the HOODS launch onto a fresh token, in one run.
//
// The opening buy-and-burn lives inside the token, and a deployed contract cannot be changed, so
// giving the launch that behaviour means a new token. The sale holds the old token, so the sale
// has to be created again too. This script does the whole chain and leaves nothing half done:
//
//   1. cancels the current sale, which returns its tokens
//   2. deploys the new token and wires it (treasury, presale factory hook, factory allowlist)
//   3. copies the token profile (description, image, links) onto the new token
//   4. creates the sale again with exactly the terms the old one had
//   5. prints the config lines the site needs
//
//   DEPLOYER_KEY=0x... npx hardhat run scripts/relaunch-hoods.js --network robinhood
//
// Environment:
//   PRESALE=0x...        the sale to move (default: the HOODS sale in deployments)
//   START_TIME=<unix>    open the new sale at another time (default: the old schedule)
//   END_TIME=<unix>      close it at another time (default: the old schedule)
//   HOODS_TOKEN=0x...    wire an already deployed new token instead of deploying one
//   DRY_RUN=1            check everything and print the plan, send nothing
//
// It refuses unless the signer owns the sale and the token, the sale is still Upcoming with
// nothing raised and no contributors, and the new token actually carries openingBuyBurn.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

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
  for (const key of ["router", "treasury", "presaleFactory", "marketingWallet", "hoodsale"]) {
    if (!d[key]) throw new Error(`deployments/${network}.json has no ${key}`);
  }
  const dryRun = process.env.DRY_RUN === "1";

  const factory = await hre.ethers.getContractAt("PresaleFactory", d.presaleFactory);
  const oldSaleAddr = process.env.PRESALE || (await factory.activePresaleOfToken(d.hoodsale));
  if (!oldSaleAddr || oldSaleAddr === hre.ethers.ZeroAddress) {
    throw new Error("no active HOODS sale found; pass PRESALE if you mean a specific one");
  }
  const oldSale = await hre.ethers.getContractAt("Presale", oldSaleAddr);
  const p = await oldSale.getParams();
  const saleOwner = await oldSale.saleOwner();
  const raised = await oldSale.totalRaised();
  const contributors = await oldSale.contributorCount();
  const state = Number(await oldSale.status());
  const wlCount = await oldSale.whitelistCount();

  console.log(`Moving the HOODS launch onto a fresh token on ${network}`);
  console.log(`  sale          ${oldSaleAddr} (${STATE[state] || state})`);
  console.log(`  old token     ${p.token}`);
  console.log(`  raised        ${E(raised)} ETH from ${contributors} contributors`);
  console.log(`  caps          soft ${E(p.softCap)}, hard ${E(p.hardCap)} ETH`);
  console.log(`  per wallet    ${E(p.minContribution)} to ${E(p.maxContribution)} ETH`);
  console.log(`  liquidity     ${Number(p.liquidityBps) / 100}%, ${Number(p.liquidityAction) === 1 ? "burned" : "locked"}`);
  console.log(`  schedule      ${new Date(Number(p.startTime) * 1000).toISOString()} to ${new Date(Number(p.endTime) * 1000).toISOString()}`);
  console.log(`  whitelist     ${(await oldSale.whitelistEnabled()) ? "on" : "off"}, ${wlCount} wallets`);

  if (!same(saleOwner, signer.address)) throw new Error(`the signer must own the sale (owner is ${saleOwner})`);
  if (state !== 0) throw new Error(`only a sale that has not opened can be moved (state is ${STATE[state] || state})`);
  if (raised > 0n || contributors > 0n) {
    throw new Error("this sale has taken money; it must keep its own token and its own page");
  }
  if (wlCount > 0n && process.env.ALLOW_WHITELIST_RESET !== "1") {
    throw new Error(
      `the sale has ${wlCount} whitelist wallets and they cannot be read back from the chain. ` +
        "Re-run with ALLOW_WHITELIST_RESET=1 and add them to the new sale from your own list."
    );
  }

  const oldToken = await hre.ethers.getContractAt("HoodSaleToken", p.token);
  if (!same(await oldToken.owner(), signer.address)) {
    throw new Error("the signer must own the token; the factory only accepts a sale from the token owner");
  }

  // The profile the new token has to inherit, so the sale page is not blank.
  const registry = d.metadataRegistry ? await hre.ethers.getContractAt("TokenMetadataRegistry", d.metadataRegistry) : null;
  let profile = null;
  if (registry) {
    try {
      const m = await registry.metadataOf(p.token);
      profile = {
        logoURI: m.logoURI,
        bannerURI: m.bannerURI,
        description: m.description,
        website: m.website,
        twitter: m.twitter,
        telegram: m.telegram,
        discord: m.discord,
        // The registry stamps this itself; ethers still wants every field of the tuple.
        updatedAt: 0,
      };
      console.log(`  profile       ${profile.description ? `${profile.description.length} characters, will be copied` : "empty"}`);
    } catch {
      console.log("  profile       could not be read; it will have to be set on the site afterwards");
    }
  }

  const startTime = process.env.START_TIME ? BigInt(process.env.START_TIME) : p.startTime;
  const endTime = process.env.END_TIME ? BigInt(process.env.END_TIME) : p.endTime;
  const now = BigInt((await hre.ethers.provider.getBlock("latest")).timestamp);
  if (startTime <= now) throw new Error(`the new start time is not in the future (${startTime} <= ${now})`);
  if (endTime <= startTime) throw new Error("the new end time is not after the start time");
  console.log(`  opens in      ${Math.round(Number(startTime - now) / 360) / 10} hours`);

  if (dryRun) {
    console.log("");
    console.log("DRY_RUN. The run would cancel the sale, deploy and wire a new token, copy the");
    console.log("profile onto it, and create the sale again with the terms above. Nothing was sent.");
    return;
  }

  // ------------------------------------------------------------------ 1. cancel
  console.log("");
  console.log("1. Cancelling the current sale (its tokens come back to you)");
  await (await oldSale.cancel()).wait();
  console.log(`   ${oldSaleAddr} is ${STATE[Number(await oldSale.status())]}`);

  // ------------------------------------------------------------------ 2. the new token
  console.log("");
  console.log("2. The new token");
  let tokenAddr = process.env.HOODS_TOKEN;
  if (tokenAddr) {
    if ((await hre.ethers.provider.getCode(tokenAddr)) === "0x") throw new Error(`HOODS_TOKEN has no code: ${tokenAddr}`);
    console.log(`   reusing      ${tokenAddr}`);
  } else {
    const deployed = await hre.ethers.deployContract("HoodSaleToken", [
      signer.address,
      d.router,
      d.treasury,
      d.marketingWallet,
    ]);
    await deployed.waitForDeployment();
    tokenAddr = deployed.target;
    console.log(`   deployed     ${tokenAddr}`);
  }
  const token = await hre.ethers.getContractAt("HoodSaleToken", tokenAddr);
  if (same(tokenAddr, p.token)) throw new Error("the new token is the old token");
  if ((await token.symbol()) !== "HOODS") throw new Error(`the new token is not HOODS: ${await token.symbol()}`);
  if ((await token.openingDone()) !== false || (await token.poolOpenedBlock()) !== 0n) {
    throw new Error("this token has already been launched; deploy a fresh one");
  }
  console.log(`   supply       ${E(await token.totalSupply())} to ${signer.address}`);
  console.log("   carries openingBuyBurn");

  const treasury = await hre.ethers.getContractAt("Treasury", d.treasury);
  const wire = async (label, current, wanted, send) => {
    if (same(current, wanted)) {
      console.log(`   ${label}: already ${wanted}`);
      return;
    }
    await (await send()).wait();
    console.log(`   ${label}: set to ${wanted}`);
  };
  await wire("treasury.hoodsale", await treasury.hoodsale(), tokenAddr, () => treasury.setHoodsale(tokenAddr));
  await wire("token.presaleFactory", await token.presaleFactory(), d.presaleFactory, () =>
    token.setPresaleFactory(d.presaleFactory)
  );
  if (!(await factory.allowedToken(tokenAddr))) {
    await (await factory.setTokenAllowed(tokenAddr, true)).wait();
    console.log(`   factory.allowedToken: ${tokenAddr} allowed`);
  }
  if (await factory.allowedToken(p.token)) {
    await (await factory.setTokenAllowed(p.token, false)).wait();
    console.log(`   factory.allowedToken: ${p.token} removed`);
  }

  // ------------------------------------------------------------------ 3. the profile
  if (registry && profile && (profile.description || profile.logoURI)) {
    console.log("");
    console.log("3. Copying the token profile");
    try {
      await (await registry.setMetadata(tokenAddr, profile)).wait();
      console.log("   copied: description, image, banner and links");
    } catch (e) {
      console.log(`   WARNING: could not copy it (${(e.shortMessage || e.message).slice(0, 90)}).`);
      console.log("   Set it on the site from the sale page once the sale exists.");
    }
  }

  // ------------------------------------------------------------------ 4. the sale
  console.log("");
  console.log("4. The sale, on the same terms");
  const next = {
    token: tokenAddr,
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
  await (await token.approve(d.presaleFactory, required)).wait();
  await (await factory.createPresale(next, { value: await factory.creationFee() })).wait();
  const saleAddr = await factory.allPresales((await factory.allPresalesLength()) - 1n);
  const sale = await hre.ethers.getContractAt("Presale", saleAddr);
  console.log(`   created      ${saleAddr}`);
  console.log(`   state        ${STATE[Number(await sale.status())]}`);
  console.log(`   holds        ${E(await token.balanceOf(saleAddr))} tokens`);
  console.log(`   exempt       ${await token.isExcludedFromFees(saleAddr)}`);

  const addresses = {
    ...d,
    hoodsale: tokenAddr,
    previousHoodsale: p.token,
    hoodsalePresale: saleAddr,
  };
  fs.writeFileSync(file, JSON.stringify(addresses, null, 2) + "\n");
  console.log(`   saved to deployments/${network}.json`);

  // ------------------------------------------------------------------ next
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  console.log("");
  console.log("Next");
  console.log(`  1. frontend/src/config/addresses.js, chain ${chainId}: hoodsale -> '${tokenAddr}'`);
  console.log(`  2. frontend/src/config/presaleRedirects.js, chain ${chainId}: point BOTH old sales here`);
  console.log(`       '${oldSaleAddr}': '${saleAddr}',`);
  console.log(`  3. frontend/src/config/whitelistForms.js: move the form entry onto '${saleAddr}'`);
  console.log(`  4. frontend/src/config/hidden.js: add '${oldSaleAddr}'`);
  console.log(`  5. Verify the new token and the new sale:`);
  console.log(`       ADDRESSES=${tokenAddr},${saleAddr} npx hardhat run scripts/verify-contract.js --network ${network}`);
  console.log(`  6. Build and deploy the site, then add the whitelist wallets to ${saleAddr}`);
  console.log("");
  console.log(`At launch:  PRESALE=${saleAddr} OPENING_ETH=<eth> npx hardhat run scripts/launch-hoods.js --network ${network}`);
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
