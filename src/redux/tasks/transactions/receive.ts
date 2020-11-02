import { Block, AssetSymbol, fromBlockchainObject, Signature, KeySet } from '@tixl/tixl-types';

import { ThunkDispatch, RootState } from '../..';
import { getReceiveBlock, getAccountChain } from '../../chains/selectors';
import { doneTask, progressTask, waitNetwork, signalReceive, abortTask } from '../actions';
import { getBlock } from '../../../requests/getBlock';
import { runOnWorker } from '../../../helpers/worker';
import { getBlockchainInfo } from '../../../requests/getBlockchainInfo';
import { shortSignatureEmoji } from '../../../helpers/hash';
import { getKeys } from '../../keys/selectors';
import { updateChain } from '../../chains/actions';
import { postTransactions } from '../../../requests/postTransaction';
import { ReceiveTaskData } from '../actionTypes';
import { ReceiveChanges } from '../../../workflows/receive';

export async function handleReceiveTask(dispatch: ThunkDispatch, state: RootState, task: ReceiveTaskData) {
  console.log('receive', { task });

  // check if send signature is already in the blockchain store
  if (getReceiveBlock(state, task.sendSignature) !== null) {
    console.log('receive task already done, send signature found in blockchain');
    dispatch(doneTask(task.id));
    return;
  }

  await dispatch(progressTask(task));

  let fullBlock = await getBlock(task.sendSignature, task.sendHash);

  if (fullBlock === undefined) {
    fullBlock = await getBlock(task.sendSignature);
  }

  if (fullBlock !== undefined) {
    try {
      if (task.symbol) {
        const signatures = await dispatch(createReceiveTransaction(fullBlock, task.symbol));

        if (signatures) {
          dispatch(waitNetwork(task, signatures));
        }
      } else {
        const correspondingChainInfo = await getBlockchainInfo(task.sendSignature);

        if (!correspondingChainInfo) {
          console.error('Cannot fetch assetsymbol for send block: send chain probably unknown');
          dispatch(abortTask(task.id));
          return;
        }

        const signatures = await dispatch(createReceiveTransaction(fullBlock, correspondingChainInfo.assetSymbol));

        if (signatures) {
          dispatch(waitNetwork(task, signatures));
        }
      }
    } catch (error) {
      console.error(error);
    }
  } else {
    console.error('Got send block for wallet, but could not receive full block', {
      signature: shortSignatureEmoji(task.sendSignature),
    });

    dispatch(abortTask(task.id));
    return;
  }
}

export function createReceiveTransaction(send: Block, assetSymbol: AssetSymbol) {
  return async (dispatch: ThunkDispatch, getState: () => RootState) => {
    dispatch(signalReceive());

    const state = getState();

    const accountChain = fromBlockchainObject(getAccountChain(state));
    const keySet = getKeys(state);

    if (!accountChain) return;
    if (!keySet) return;

    const receiveData = await runOnWorker<ReceiveChanges>('receive', keySet, accountChain, send, assetSymbol);

    if (!receiveData) return;

    const updates = [];
    const txs = [];

    if (receiveData.accountchainAsset) {
      updates.push(receiveData.accountchainAsset);
      txs.push(receiveData.accountchainAsset.tx);
    }

    if (receiveData.assetReceive) {
      updates.push(receiveData.assetReceive);
      txs.push(receiveData.assetReceive.tx);
    }

    // write updates to own state
    await Promise.all(
      updates.map(async (update) => {
        dispatch(updateChain(update.blockchain));
      }),
    );

    // send txs
    await postTransactions(txs);

    // collect new block signatures and wait for network result
    const signatures: Signature[] = [];
    updates.forEach((upd) => upd.tx.blocks.forEach((block) => signatures.push(block.signature)));

    return signatures;
  };
}
