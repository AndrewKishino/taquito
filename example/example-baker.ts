import { BakerUtils } from '@taquito/baker-utils';
const provider = 'https://api.tez.ie/rpc/carthagenet';

const bakerUtils = new BakerUtils(provider);

async function example() {
  try {
    const rewards = await bakerUtils.getCycleRewards('tz1aWXP237BLwNHJcCD4b3DutCevhqq2T1Z9', 129, {
      paymentSplit: 0.95,
    });
    console.log(JSON.stringify(rewards, null, 2));
  } catch (ex) {
    console.error(ex);
  }
}

// tslint:disable-next-line: no-floating-promises
example();
