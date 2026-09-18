const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployPlatformV4, taxConfig } = require("./helpers");

const E = ethers.parseEther;
const FEE = E("0.1");
const DAY = 86400n;
const Lock = 0, Burn = 1;

// A quick launch finalizes itself inside someone's buy, so the gas it needs has to be known in
// advance: Presale.LAUNCH_BASE_GAS_V4 is what autoLaunchGas() reserves for it. This measures the
// real cost of both liquidity choices and keeps the constant honest.
describe("V4 launch gas", function () {
  async function measure(liquidityAction) {
    const ctx = await deployPlatformV4();
    const { launcher, presaleFactory, alice, bob, carol, marketing } = ctx;
    const now = BigInt(await time.latest());
    const start = now + 1000n;

    await launcher.connect(alice).createToken(
      0,
      { name: "Gas", symbol: "GAS", totalSupply: E("1000000"), rewardToken: ethers.ZeroAddress },
      taxConfig(marketing.address, { taxLocked: true, walletLocked: true }),
      alice.address
    );
    const created = await launcher.tokensOfCreator(alice.address);
    const tokenAddr = created[created.length - 1];
    const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr);

    const params = {
      token: tokenAddr,
      presaleRate: E("1000"),
      listingRate: E("800"),
      softCap: E("5"),
      hardCap: E("10"),
      minContribution: E("0.1"),
      maxContribution: E("5"),
      startTime: start,
      endTime: start + DAY,
      liquidityBps: 6000,
      liquidityAction,
      lockDuration: 30n * DAY,
      launchTime: 0,
      whitelistEnabled: false,
    };
    await token.connect(alice).approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
    await presaleFactory.connect(alice).createPresale(params, { value: FEE });
    const presale = await ethers.getContractAt(
      "Presale",
      await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n)
    );
    await time.increaseTo(start);
    await presale.connect(bob).contribute({ value: E("5") });
    await presale.connect(carol).contribute({ value: E("5") });
    const receipt = await (await presale.connect(alice).finalize(0, 0)).wait();
    return { gas: receipt.gasUsed, presale };
  }

  it("finalizes a locked launch inside the reserved gas", async function () {
    const { gas, presale } = await measure(Lock);
    const reserved = await presale.LAUNCH_BASE_GAS_V4();
    console.log(`      lock: ${gas} gas used, ${reserved} reserved`);
    expect(gas).to.be.lessThan(reserved);
  });

  it("finalizes a burned launch inside the reserved gas", async function () {
    const { gas, presale } = await measure(Burn);
    const reserved = await presale.LAUNCH_BASE_GAS_V4();
    console.log(`      burn: ${gas} gas used, ${reserved} reserved`);
    expect(gas).to.be.lessThan(reserved);
  });
});
