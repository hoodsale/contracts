// Redeploys the platform token on an existing deployment (the audit generation: no swap switch
// and no manual swap; the presale factory keeps its hook to exempt the HOODS sale contract from
// the tax when the sale is created).
//
// Reads deployments/<network>.json, deploys HoodSaleToken(deployer, router, treasury,
// marketingWallet) with the same arguments scripts/deploy.js uses (the whole supply goes to the
// deployer, the constructor opens the token/WETH pair and excludes the owner, the token itself,
// the Treasury and the burn address from the tax), then wires what deploy.js wires for the token:
// treasury.setHoodsale (the buyback target, Treasury owner), hoodsale.setPresaleFactory (lets the
// factory exempt the sale contract from tax, token owner) and presaleFactory.setTokenAllowed
// (PresaleFactory owner). The token currently in the file loses its allowlist entry and is
// remembered under previousHoodsale; it keeps its old symbol and stays where it is. Every other
// address in the file is kept. No presale of the previous token exists and its pool has no
// liquidity, so nothing else has to move.
//
//   DEPLOYER_KEY=0x... npx hardhat run scripts/deploy-hoodsale-token.js --network robinhood
//
// Optional environment:
//   WIRE=0                  deploy only: the token is written to the file as hoodsaleCandidate
//                           and nothing on the platform is pointed at it (for an audit scan
//                           first); run again with HOODS_TOKEN=<that address> to wire it
//   HOODS_TOKEN=0x...       reuse an already deployed new HoodSaleToken (must carry the HOODS
//                           symbol and point at this deployment's router and Treasury)
//   MARKETING_WALLET=0x...  marketing wallet of the new token (default: the one in the file)
//
// Safe to re-run: every wiring step is skipped when the chain already holds the value.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("no signer: set DEPLOYER_KEY");
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const key of ["router", "treasury", "presaleFactory"]) {
    if (!d[key]) throw new Error(`deployments/${network}.json has no ${key}`);
  }
  const marketingWallet = process.env.MARKETING_WALLET || d.marketingWallet;
  if (!marketingWallet || !hre.ethers.isAddress(marketingWallet)) {
    throw new Error("no marketing wallet: put marketingWallet into the deployments file or set MARKETING_WALLET");
  }
  console.log(`Redeploying HoodSaleToken on ${network} with ${deployer.address}`);
  console.log(`Current hoodsale ${d.hoodsale || "-"}, treasury ${d.treasury}, presaleFactory ${d.presaleFactory}, router ${d.router}`);
  console.log(`Marketing wallet ${marketingWallet}`);

  const wireIt = process.env.WIRE !== "0";
  const treasury = await hre.ethers.getContractAt("Treasury", d.treasury);
  const presaleFactory = await hre.ethers.getContractAt("PresaleFactory", d.presaleFactory);
  // treasury.setHoodsale is restricted to the Treasury owner, presaleFactory.setTokenAllowed to
  // the PresaleFactory owner: both must be the deployer for the wiring below
  const treasuryOwner = await treasury.owner();
  const presaleFactoryOwner = await presaleFactory.owner();
  if (wireIt && !same(treasuryOwner, deployer.address)) {
    throw new Error(`the deployer must own Treasury (owner is ${treasuryOwner})`);
  }
  if (wireIt && !same(presaleFactoryOwner, deployer.address)) {
    throw new Error(`the deployer must own PresaleFactory (owner is ${presaleFactoryOwner})`);
  }

  let hoodsale;
  if (process.env.HOODS_TOKEN) {
    const addr = process.env.HOODS_TOKEN;
    if (!hre.ethers.isAddress(addr)) throw new Error(`HOODS_TOKEN is not an address: ${addr}`);
    if ((await hre.ethers.provider.getCode(addr)) === "0x") throw new Error(`HOODS_TOKEN has no code on ${network}: ${addr}`);
    hoodsale = await hre.ethers.getContractAt("HoodSaleToken", addr);
    console.log(`HoodSaleToken: reusing ${addr}`);
  } else {
    hoodsale = await hre.ethers.deployContract("HoodSaleToken", [
      deployer.address,
      d.router,
      d.treasury,
      marketingWallet,
    ]);
    await hoodsale.waitForDeployment();
    console.log(`HoodSaleToken: deployed ${hoodsale.target}`);
  }
  if (d.hoodsale && same(d.hoodsale, hoodsale.target)) {
    throw new Error(`${hoodsale.target} is already the token in deployments/${network}.json`);
  }
  if ((await hoodsale.symbol()) !== "HOODS") {
    throw new Error(`${hoodsale.target} does not carry the HOODS symbol (symbol is ${await hoodsale.symbol()})`);
  }
  if (!same(await hoodsale.router(), d.router)) {
    throw new Error("HoodSaleToken does not point at this deployment's router");
  }
  if (!same(await hoodsale.treasury(), d.treasury)) {
    throw new Error("HoodSaleToken does not point at this deployment's Treasury");
  }
  const tokenOwner = await hoodsale.owner();
  if (!same(tokenOwner, deployer.address)) {
    throw new Error(`the deployer must own the new HoodSaleToken (owner is ${tokenOwner})`);
  }
  // The audit generation has no manualSwapBack and no swap switch: a reused address must be that generation
  const code = ((await hre.ethers.provider.getCode(hoodsale.target)) || "").toLowerCase();
  if (code.includes(hre.ethers.id("manualSwapBack()").slice(2, 10)) || code.includes(hre.ethers.id("setSwapEnabled(bool)").slice(2, 10))) {
    throw new Error(`${hoodsale.target} still carries manualSwapBack or setSwapEnabled: not the audit generation of HoodSaleToken`);
  }

  if (!wireIt) {
    const addresses = { ...d, hoodsaleCandidate: hoodsale.target };
    fs.writeFileSync(file, JSON.stringify(addresses, null, 2));
    console.log(`Saved as hoodsaleCandidate in deployments/${network}.json; nothing on the platform points at it yet.`);
    console.log(`Next: verify it (scripts/verify-contract.js), run the audit scan, then wire it with`);
    console.log(`  HOODS_TOKEN=${hoodsale.target} npx hardhat run scripts/deploy-hoodsale-token.js --network ${network}`);
    return;
  }

  const wire = async (label, current, wanted, send) => {
    if (same(current, wanted)) {
      console.log(`${label}: already ${wanted}`);
    } else {
      await (await send()).wait();
      console.log(`${label}: set to ${wanted}`);
    }
  };
  const allow = async (token, wanted) => {
    const current = await presaleFactory.allowedToken(token);
    if (current === wanted) {
      console.log(`presaleFactory.allowedToken(${token}): already ${wanted}`);
    } else {
      await (await presaleFactory.setTokenAllowed(token, wanted)).wait();
      console.log(`presaleFactory.allowedToken(${token}): set to ${wanted}`);
    }
  };

  // The buyback target of the Treasury (executeBuyback buys and burns this token)
  await wire("treasury.hoodsale", await treasury.hoodsale(), hoodsale.target, () => treasury.setHoodsale(hoodsale.target));
  // deploy.js sets the Treasury router at first deployment; a Treasury that lost it is repaired here
  await wire("treasury.router", await treasury.router(), d.router, () => treasury.setRouter(d.router));
  // Let the token run its own presale through the platform
  await wire("hoodsale.presaleFactory", await hoodsale.presaleFactory(), d.presaleFactory, () =>
    hoodsale.setPresaleFactory(d.presaleFactory)
  );
  await allow(hoodsale.target, true);
  if (d.hoodsale) await allow(d.hoodsale, false);

  const addresses = { ...d, hoodsale: hoodsale.target };
  delete addresses.hoodsaleCandidate;
  if (d.hoodsale) addresses.previousHoodsale = d.hoodsale;
  fs.writeFileSync(file, JSON.stringify(addresses, null, 2));
  console.log(`Saved to deployments/${network}.json`);

  if (network === "hardhat" || network === "localhost") {
    const frontendConfig = path.join(__dirname, "..", "..", "frontend", "src", "config", "localhost.json");
    if (fs.existsSync(path.dirname(frontendConfig))) {
      fs.writeFileSync(frontendConfig, JSON.stringify(addresses, null, 2));
      console.log("Updated frontend/src/config/localhost.json");
    }
  }

  console.log("");
  console.log("New token");
  console.log(`  hoodsale            ${hoodsale.target}`);
  console.log(`  previousHoodsale    ${addresses.previousHoodsale || "-"}`);
  console.log(`  name                ${await hoodsale.name()}`);
  console.log(`  symbol              ${await hoodsale.symbol()}`);
  console.log(`  totalSupply         ${hre.ethers.formatEther(await hoodsale.totalSupply())}`);
  console.log(`  owner               ${await hoodsale.owner()}`);
  console.log(`  ownerBalance        ${hre.ethers.formatEther(await hoodsale.balanceOf(deployer.address))}`);
  console.log(`  mainPair            ${await hoodsale.mainPair()}`);
  console.log(`  marketingWallet     ${await hoodsale.marketingWallet()}`);
  console.log(`  presaleFactory      ${await hoodsale.presaleFactory()}`);
  console.log(`  treasury.hoodsale   ${await treasury.hoodsale()}`);
  console.log(`  allowlisted         ${await presaleFactory.allowedToken(hoodsale.target)}`);
  if (addresses.previousHoodsale) {
    console.log(`  previous allowlisted ${await presaleFactory.allowedToken(addresses.previousHoodsale)}`);
  }
  if (network !== "hardhat" && network !== "localhost") {
    console.log("");
    console.log("Next: verify the new token on Sourcify (the keeper never verifies platform contracts on its own):");
    console.log(`  ADDRESSES=${hoodsale.target} npx hardhat run scripts/verify-contract.js --network ${network}`);
    console.log("Then put hoodsale into frontend/src/config/addresses.js for this chain and run");
    console.log(`  npx hardhat run scripts/check-deployment.js --network ${network}`);
    console.log("hoodsale_symbol must read HOODS and presaleFactory_hoodsaleAllowed true before the frontend is wired.");
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
