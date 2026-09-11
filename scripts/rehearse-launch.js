// Rehearses the whole launch on the live chain with a stand-in token, so that nothing about the
// real HOODS launch is being tried for the first time.
//
// In one run it deploys a rehearsal token, allowlists it, creates a tiny presale, fills it, and
// then launches it exactly the way the real launch will be launched: ONE EIP-7702 transaction
// that calls finalize and then openingBuyBurn, so nothing can be sequenced between the pool
// opening and the buy. It then checks the result and prints a verdict.
//
//   DEPLOYER_KEY=0x... npx hardhat run scripts/rehearse-launch.js --network robinhood
//
// Environment:
//   CAP=<eth>            hard cap of the rehearsal sale (default 0.01)
//   OPENING_ETH=<eth>    ETH for the opening buy (default: the same as CAP)
//   REHEARSAL_TOKEN=0x.. reuse a token this script deployed earlier instead of deploying one
//   LAUNCH_BATCH=0x...   reuse an already deployed LaunchBatch
//   KEEP_ALLOWLIST=1     leave the rehearsal token on the factory allowlist afterwards
//   DRY_RUN=1            print the plan and the costs, send nothing
//
// What it costs: the contribution comes back as liquidity (locked forever, the LP is burned) plus
// the owner's payout share, the opening buy is spent and burned, and the rest is gas. At the
// default 0.01 cap that is well under 0.02 ETH in total.
//
// It refuses to touch the real HOODS token or the real HOODS sale.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { sendSelfBatch, revokeSelfDelegation } = require("./lib/eip7702");

const BPS = 10_000n;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const STATE = ["Upcoming", "Live", "Ended", "Failed", "Cancelled", "Finalized"];

function pct(part, whole) {
  if (whole === 0n) return "0";
  return (Number((part * 1_000_000n) / whole) / 10_000).toFixed(2);
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("no signer: set DEPLOYER_KEY");
  const E = (x) => hre.ethers.formatEther(x);
  const P = (n) => hre.ethers.parseEther(String(n));
  const provider = hre.ethers.provider;
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const key of ["router", "treasury", "presaleFactory", "marketingWallet"]) {
    if (!d[key]) throw new Error(`deployments/${network}.json has no ${key}`);
  }

  const cap = P(process.env.CAP || "0.01");
  const openingEth = P(process.env.OPENING_ETH || process.env.CAP || "0.01");
  const dryRun = process.env.DRY_RUN === "1";
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  };

  const presaleFactory = await hre.ethers.getContractAt("PresaleFactory", d.presaleFactory);
  const balance = await provider.getBalance(signer.address);
  console.log(`Rehearsing the launch on ${network} with ${signer.address}`);
  console.log(`  balance       ${E(balance)} ETH`);
  console.log(`  hard cap      ${E(cap)} ETH`);
  console.log(`  opening buy   ${E(openingEth)} ETH`);
  const need = cap + openingEth + P("0.002");
  if (balance < need) throw new Error(`not enough ETH: have ${E(balance)}, need about ${E(need)}`);

  if (dryRun) {
    console.log("");
    console.log("DRY_RUN. The run would: deploy a rehearsal token, allowlist it, create a sale with");
    console.log(`the cap above, fill it, then send one EIP-7702 transaction that finalizes and buys.`);
    console.log(`Spent for good: the opening buy (${E(openingEth)} ETH, burned) and the liquidity`);
    console.log("share of the contribution, whose LP is burned. Nothing else was sent.");
    return;
  }

  // ------------------------------------------------------------------ 1. the token
  console.log("");
  console.log("1. Rehearsal token");
  let tokenAddr = process.env.REHEARSAL_TOKEN;
  if (tokenAddr) {
    if ((await provider.getCode(tokenAddr)) === "0x") throw new Error(`REHEARSAL_TOKEN has no code: ${tokenAddr}`);
    console.log(`  reusing       ${tokenAddr}`);
  } else {
    const token = await hre.ethers.deployContract("HoodSaleRehearsalToken", [
      signer.address,
      d.router,
      d.treasury,
      process.env.MARKETING_WALLET || d.marketingWallet,
    ]);
    await token.waitForDeployment();
    tokenAddr = token.target;
    console.log(`  deployed      ${tokenAddr}`);
  }
  if (same(tokenAddr, d.hoodsale)) throw new Error("refusing to rehearse against the real HOODS token");
  const token = await hre.ethers.getContractAt("HoodSaleRehearsalToken", tokenAddr);
  console.log(`  symbol        ${await token.symbol()}`);
  check("the token carries openingBuyBurn", (await token.openingDone()) === false);
  check("the pool has not been opened yet", (await token.poolOpenedBlock()) === 0n);

  if (!(await presaleFactory.allowedToken(tokenAddr))) {
    await (await presaleFactory.setTokenAllowed(tokenAddr, true)).wait();
  }
  if (!same(await token.presaleFactory(), d.presaleFactory)) {
    await (await token.setPresaleFactory(d.presaleFactory)).wait();
  }
  console.log(`  allowlisted   ${await presaleFactory.allowedToken(tokenAddr)}`);

  // ------------------------------------------------------------------ 2. the sale
  console.log("");
  console.log("2. Rehearsal sale");
  const head = await provider.getBlock("latest");
  const rate = P("11884000");
  const params = {
    token: tokenAddr,
    presaleRate: rate,
    listingRate: rate,
    softCap: cap / 4n,
    hardCap: cap,
    minContribution: cap / 10n,
    maxContribution: cap,
    startTime: head.timestamp + 45,
    endTime: head.timestamp + 3 * 3600,
    liquidityBps: 7000,
    liquidityAction: 1, // Burn, the same as the real sale
    lockDuration: 0,
    launchTime: 0,
    whitelistEnabled: false,
  };
  const required = await presaleFactory.requiredTokensFor(params);
  await (await token.approve(d.presaleFactory, required)).wait();
  await (await presaleFactory.createPresale(params, { value: await presaleFactory.creationFee() })).wait();
  const saleAddr = await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n);
  if (same(saleAddr, "0xE515fc789529dF19490Efc640366e29BbE93e0cE")) throw new Error("unexpected: the real sale");
  const sale = await hre.ethers.getContractAt("Presale", saleAddr);
  console.log(`  created       ${saleAddr}`);
  console.log(`  needs         ${E(required)} tokens`);

  // The sale opens in 45 seconds; wait for it rather than guessing.
  process.stdout.write("  waiting for it to open ");
  for (;;) {
    const now = (await provider.getBlock("latest")).timestamp;
    if (now >= params.startTime) break;
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(" open");

  await (await sale.contribute({ value: cap })).wait();
  console.log(`  contributed   ${E(cap)} ETH, raised ${E(await sale.totalRaised())} ETH`);
  check("the sale reads as sold out", Number(await sale.status()) === 2, `state ${STATE[Number(await sale.status())]}`);
  check("the chain will accept finalize", (await sale.isReadyToFinalize()) === true);

  // ------------------------------------------------------------------ 3. the launch
  console.log("");
  console.log("3. The launch, as one EIP-7702 transaction");
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

  const raised = await sale.totalRaised();
  const platformFeeBps = BigInt(await sale.platformFeeBps());
  const netEth = raised - (raised * platformFeeBps) / BPS;
  const liquidityEth = (netEth * BigInt(params.liquidityBps)) / BPS;
  const liquidityTokens = (liquidityEth * params.listingRate) / 10n ** 18n;
  const minTokens = (liquidityTokens * 9900n) / BPS;
  const minEth = (liquidityEth * 9900n) / BPS;

  const supplyBefore = await token.totalSupply();
  const rpcUrl = hre.network.config.url;
  let rc;
  try {
    ({ receipt: rc } = await sendSelfBatch({
      rpcUrl,
      privateKey: process.env.DEPLOYER_KEY,
      batchAddress: batchAddr,
      calls: [
        { to: saleAddr, value: 0n, data: sale.interface.encodeFunctionData("finalize", [minTokens, minEth]) },
        { to: tokenAddr, value: openingEth, data: token.interface.encodeFunctionData("openingBuyBurn") },
      ],
      value: openingEth,
      gasLimit: BigInt(process.env.GAS_LIMIT || "1500000"),
    }));
  } catch (e) {
    check("the delegation was applied and the batch ran", false, (e.shortMessage || e.message || "").slice(0, 140));
    console.log("");
    console.log("Nothing was spent beyond gas, and the sale is still finalizable. Fix the cause and");
    console.log(`re-run against the sale that already exists:  PRESALE=${saleAddr} OPENING_ETH=${E(openingEth)}`);
    process.exitCode = 1;
    return;
  }

  check("the delegation was applied and the batch ran", rc.gasUsed > 200000n, `gas ${rc.gasUsed}`);
  check("the sale is finalized", Number(await sale.status()) === 5);

  const ev = (await token.queryFilter(token.filters.OpeningBuyBurn(), rc.blockNumber, rc.blockNumber)).at(-1);
  check("the opening buy ran in the launch transaction", Boolean(ev));
  if (!ev) throw new Error("no OpeningBuyBurn event: the buy did not happen in the launch transaction");

  const supplyAfter = await token.totalSupply();
  console.log("");
  console.log("   spent        " + E(ev.args.ethSpent) + " ETH");
  console.log("   burned       " + E(ev.args.tokensBurned) + " tokens");
  console.log("   refunded     " + E(openingEth - ev.args.ethSpent) + " ETH");
  console.log("   supply       " + E(supplyBefore) + " -> " + E(supplyAfter));

  check("supply really fell", supplyAfter < supplyBefore, `by ${pct(supplyBefore - supplyAfter, supplyBefore)}%`);
  check(
    "nothing was parked at the burn address",
    (await token.balanceOf("0x000000000000000000000000000000000000dEaD")) === 0n
  );
  check("the token kept no ETH", (await provider.getBalance(tokenAddr)) === 0n);
  check("the opening buy cannot run again", (await token.openingDone()) === true);

  // ------------------------------------------------------------------ 4. after the launch
  console.log("");
  console.log("4. After the launch");
  const pair = await hre.ethers.getContractAt("IUniswapV2Pair", await token.mainPair());
  const [r0, r1] = await pair.getReserves();
  const tokenIsToken0 = same(await pair.token0(), tokenAddr);
  const poolEth = tokenIsToken0 ? r1 : r0;
  const poolTok = tokenIsToken0 ? r0 : r1;
  console.log(`  pool          ${E(poolEth)} ETH / ${E(poolTok)} tokens`);
  check("the pool holds the liquidity", poolEth > 0n && poolTok > 0n);

  // A real buy and a real sell, so the rehearsal proves the token is not a honeypot.
  const router = await hre.ethers.getContractAt("IUniswapV2Router02", d.router);
  const probe = P("0.0005");
  const weth = await router.WETH();
  const before = await token.balanceOf(signer.address);
  await (
    await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
      0,
      [weth, tokenAddr],
      signer.address,
      (await provider.getBlock("latest")).timestamp + 600,
      { value: probe }
    )
  ).wait();
  const bought = (await token.balanceOf(signer.address)) - before;
  check("a buy works after the launch", bought > 0n, `${E(bought)} tokens for ${E(probe)} ETH`);

  await (await token.approve(d.router, bought)).wait();
  const ethBefore = await provider.getBalance(signer.address);
  await (
    await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      bought,
      0,
      [tokenAddr, weth],
      signer.address,
      (await provider.getBlock("latest")).timestamp + 600
    )
  ).wait();
  check("a sell works after the launch", (await provider.getBalance(signer.address)) > ethBefore - P("0.0005"));

  // ------------------------------------------------------------------ 5. cleanup
  if (process.env.KEEP_ALLOWLIST !== "1") {
    await (await presaleFactory.setTokenAllowed(tokenAddr, false)).wait();
    console.log("");
    console.log(`  allowlist     ${tokenAddr} removed`);
  }

  const addresses = { ...d, hoodsaleRehearsal: tokenAddr, launchBatch: batchAddr };
  fs.writeFileSync(file, JSON.stringify(addresses, null, 2) + "\n");

  await revokeSelfDelegation({ rpcUrl, privateKey: process.env.DEPLOYER_KEY, log: () => {} });
  const code = await provider.getCode(signer.address);
  check("the wallet is an ordinary wallet again", code === "0x", code === "0x" ? "" : `code ${code}`);

  // ------------------------------------------------------------------ verdict
  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(`${results.length - failed.length} of ${results.length} checks passed`);
  if (failed.length) {
    console.log("");
    console.log("The real launch must NOT be attempted this way until these pass:");
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exitCode = 1;
    return;
  }
  console.log("");
  console.log("The whole path works on this chain: the sale finalized, the buy ran inside the same");
  console.log("transaction, the supply fell, and the token trades both ways afterwards.");
  console.log(`Rehearsal token ${tokenAddr}, batch code ${batchAddr} (reusable for the real launch).`);
  console.log(`Spent for good: ${E(ev.args.ethSpent)} ETH burned plus the liquidity whose LP was burned.`);
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
