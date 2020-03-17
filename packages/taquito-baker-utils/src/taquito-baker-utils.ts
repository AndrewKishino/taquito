import { RpcClient } from '@taquito/rpc';
import BigNumber from 'bignumber.js';

type cycleConstants = {
  blocksPerSnapshot: number;
  blocksPerCycle: number;
  preservedCycles: number;
};

type rewardOptions = {
  paymentSplit?: number;
  minimumPayout?: number;
  minimumDelegation?: number;
  retainPayoutLessThanMin?: boolean;
  transactionFeeFromPayout?: boolean;
  retainRewardsFromUninvited?: boolean;
  payOwnBlocks?: boolean;
  compensateMissedBlocks?: boolean;
  payStolenBlocks?: boolean;
  payEndorsementRewards?: boolean;
  compensateMissedEndorsement?: boolean;
  compensateLowPriorityEndorsement?: boolean;
  payGainsFromFees?: boolean;
  payGainsFromAccusations?: boolean;
  subtractLostDepositsWhenAccused?: boolean;
  subtractLostRewardsWhenAccused?: boolean;
  subtractLostFeesWhenAccused?: boolean;
  payRevelationRewards?: boolean;
  subtractLostRewardsWhenMissRevelation?: boolean;
  subtractLostFeesWhenMissRevelation?: boolean;
  whitelistedDelegates?: Array<string>;
  rolloverRewards?: { [address: string]: BigNumber };
};

const toMutezBigNumber = (tez: number) => new BigNumber(tez).multipliedBy(1000000);

export class BakerUtils {
  private rpc = new RpcClient();

  constructor(rpcProvider: string | RpcClient) {
    if (rpcProvider && rpcProvider instanceof RpcClient) {
      this.rpc = rpcProvider;
    } else if (rpcProvider) {
      this.rpc = new RpcClient(rpcProvider);
    }
  }

  async getConstants(level: string | number = 'head'): Promise<cycleConstants> {
    let block = level;

    const {
      blocks_per_roll_snapshot,
      blocks_per_cycle,
      preserved_cycles,
    } = await this.rpc.getConstants({ block });

    return {
      blocksPerSnapshot: blocks_per_roll_snapshot,
      blocksPerCycle: blocks_per_cycle,
      preservedCycles: preserved_cycles,
    };
  }

  getBalancesAtBlock(
    addresses: Array<string>,
    block: number
  ): Promise<Array<{ address: string; balance: BigNumber }>> {
    return Promise.all(
      addresses.map(
        async (address: string): Promise<{ address: string; balance: BigNumber }> => {
          const balance = await this.rpc.getBalance(address, { block });
          return {
            address,
            balance,
          };
        }
      )
    );
  }

  calculateRewardShares(
    delegateBalances: Array<{ address: string; balance: BigNumber }>,
    stakingBalance: BigNumber,
    rewardsMinusFee: BigNumber,
    {
      minimumPayout = 0,
      minimumDelegation = 0,
      retainPayoutLessThanMin = true,
      retainRewardsFromUninvited = true,
      whitelistedDelegates,
      rolloverRewards = {},
    }: rewardOptions = {}
  ): {
    rewardShares: Array<{
      address: string;
      reward: BigNumber;
      balance: BigNumber;
      share: BigNumber;
    }>;
    rolloverRewards: { [account: string]: BigNumber };
  } {
    let adjustedStakingBalance = stakingBalance;
    const newRolloverRewards = rolloverRewards;
    let whitelist = whitelistedDelegates || delegateBalances.map(({ address }) => address);

    const filteredDelegates = delegateBalances.filter(({ address, balance }) => {
      if (retainRewardsFromUninvited && !whitelist.includes(address)) {
        adjustedStakingBalance = adjustedStakingBalance.minus(balance);
        return false;
      }

      if (balance.isLessThan(toMutezBigNumber(minimumDelegation))) {
        adjustedStakingBalance = adjustedStakingBalance.minus(balance);
        return false;
      }

      const reward = balance
        .dividedBy(adjustedStakingBalance)
        .multipliedBy(rewardsMinusFee)
        .integerValue(BigNumber.ROUND_DOWN);

      if (reward.isLessThan(toMutezBigNumber(minimumPayout))) {
        if (retainPayoutLessThanMin) {
          adjustedStakingBalance = adjustedStakingBalance.minus(balance);
          return false;
        } else {
          const previousReward = new BigNumber(newRolloverRewards[address] || 0);
          if (reward.plus(previousReward).isLessThan(toMutezBigNumber(minimumPayout))) {
            newRolloverRewards[address] = reward.plus(previousReward);
            return false;
          }
        }
      }
      return true;
    });

    const rewardShares = filteredDelegates.map(({ address, balance }) => {
      return {
        address,
        reward: balance
          .dividedBy(adjustedStakingBalance)
          .multipliedBy(rewardsMinusFee)
          .integerValue(BigNumber.ROUND_DOWN),
        balance,
        share: balance.dividedBy(adjustedStakingBalance),
      };
    });

    return {
      rewardShares,
      rolloverRewards: newRolloverRewards,
    };
  }

  async getCycleRewards(
    address: string,
    cycle: number,
    {
      paymentSplit = 0.9,
      minimumPayout = 0,
      minimumDelegation = 0,
      retainPayoutLessThanMin = true,
      retainRewardsFromUninvited = true,
      // payOwnBlocks = true,
      // compensateMissedBlocks = false,
      // payStolenBlocks = true,
      // payEndorsementRewards = true,
      // compensateMissedEndorsement = false,
      // compensateLowPriorityEndorsement = false,
      // payGainsFromFees = true,
      // payGainsFromAccusations = true,
      // subtractLostDepositsWhenAccused = true,
      // subtractLostRewardsWhenAccused = true,
      // subtractLostFeesWhenAccused = true,
      // payRevelationRewards = true,
      // subtractLostRewardsWhenMissRevelation = true,
      // subtractLostFeesWhenMissRevelation = true,
      // transactionFeeFromPayout = true,
      whitelistedDelegates,
      rolloverRewards,
    }: rewardOptions = {}
  ) {
    const { blocksPerCycle, preservedCycles, blocksPerSnapshot } = await this.getConstants();

    const queryLevel = (cycle + 1) * blocksPerCycle;
    const { frozen_balance_by_cycle: frozenBalanceByCycle } = await this.rpc.getDelegates(address, {
      block: queryLevel,
    });

    const { rewards: cycleRewards } = frozenBalanceByCycle.find(
      ({ cycle: balanceCycle }) => balanceCycle === cycle
    ) || { rewards: new BigNumber(0) };

    const bakingFee = cycleRewards
      .multipliedBy(1 - paymentSplit)
      .integerValue(BigNumber.ROUND_DOWN);
    const rewardsMinusFee = cycleRewards.minus(bakingFee);

    const snapshot = await this.rpc.getCycleSnapshot(cycle);
    const snapshotLevel = (cycle - 7) * blocksPerCycle + (snapshot + 1) * blocksPerSnapshot;

    const {
      staking_balance: stakingBalance,
      delegated_contracts: delegatedContracts,
    } = await this.rpc.getDelegates(address, { block: snapshotLevel });

    const cycleDelegates = delegatedContracts.filter(contract => contract !== address);
    const delegateBalances = await this.getBalancesAtBlock(cycleDelegates, snapshotLevel);

    const calculatedRewards = this.calculateRewardShares(
      delegateBalances,
      stakingBalance,
      rewardsMinusFee,
      {
        minimumPayout,
        minimumDelegation,
        retainPayoutLessThanMin,
        retainRewardsFromUninvited,
        whitelistedDelegates,
        rolloverRewards,
      }
    );

    return {
      cycle,
      frozenUntilCycle: cycle + preservedCycles + 1,
      snapshot,
      snapshotLevel,
      rewardShares: calculatedRewards.rewardShares,
      rolloverRewards: calculatedRewards.rolloverRewards,
      stakingBalance,
      cycleRewards,
      rewardsMinusFee,
      paymentSplit,
      bakingFee,
    };
  }
}
