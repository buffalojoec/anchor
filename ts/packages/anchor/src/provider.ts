import {
  Base58EncodedAddress,
  createDefaultRpcTransport,
  createSolanaRpc,
  setTransactionFeePayer,
  setTransactionLifetimeUsingBlockhash,
  signTransaction,
  Transaction,
} from "web3js-experimental";
import { bs58 } from "./utils/bytes/index.js";
import { isBrowser, isVersionedTransaction } from "./utils/common.js";
import {
  simulateTransaction,
  SuccessfulTxSimulationResponse,
} from "./utils/rpc.js";

// Type helpers for non-exported Web3 JS types.
// As of right now, these types will not be exported from the new API.
type PromiseType<T extends Promise<unknown>> = T extends Promise<infer R>
  ? R
  : never;

type SolanaRpc = ReturnType<typeof createSolanaRpc>;

type Commitment = "processed" | "confirmed" | "finalized";
type SendOptions = Parameters<
  ReturnType<typeof createSolanaRpc>["sendTransaction"]
>[1];
type ConfirmOptions = SendOptions & { commitment?: Commitment };

type TransactionSignature = PromiseType<
  ReturnType<ReturnType<SolanaRpc["sendTransaction"]>["send"]>
>;

// We don't have error types yet.
class SendTransactionError extends Error {
  constructor(message?: string, readonly logs?: string[]) {
    super(message);
  }
}

export default interface Provider {
  readonly rpc: SolanaRpc;
  readonly address?: Base58EncodedAddress;

  send?(
    tx: Transaction,
    signers?: CryptoKeyPair[],
    opts?: SendOptions
  ): Promise<TransactionSignature>;
  sendAndConfirm?(
    tx: Transaction,
    signers?: CryptoKeyPair[],
    opts?: ConfirmOptions
  ): Promise<TransactionSignature>;
  sendAll?<T extends Transaction>(
    txWithSigners: {
      tx: T;
      signers?: CryptoKeyPair[];
    }[],
    opts?: ConfirmOptions
  ): Promise<Array<TransactionSignature>>;
  simulate?(
    tx: Transaction,
    signers?: CryptoKeyPair[],
    commitment?: Commitment,
    includeAccounts?: boolean | Base58EncodedAddress[]
  ): Promise<SuccessfulTxSimulationResponse>;
}

/**
 * The network and wallet context used to send transactions paid for and signed
 * by the provider.
 */
export class AnchorProvider implements Provider {
  readonly address: Base58EncodedAddress;
  readonly rpc: SolanaRpc;

  /**
   * @param url        The cluster url where the program is deployed.
   * @param wallet     The wallet used to pay for and sign all transactions.
   * @param opts       Transaction confirmation options to use by default.
   */
  constructor(
    readonly url: string,
    readonly wallet: Wallet,
    readonly opts: ConfirmOptions
  ) {
    this.address = wallet?.address;
    this.rpc = createSolanaRpc({
      transport: createDefaultRpcTransport({ url }),
    });
  }

  static defaultOptions(): ConfirmOptions {
    return {
      commitment: "processed",
      encoding: "base64",
      preflightCommitment: "processed",
    };
  }

  /**
   * Returns a `Provider` with a wallet read from the local filesystem.
   *
   * @param url  The network cluster url.
   * @param opts The default transaction confirmation options.
   *
   * (This api is for Node only.)
   */
  static local(url?: string, opts?: ConfirmOptions): AnchorProvider {
    if (isBrowser) {
      throw new Error(`Provider local is not available on browser.`);
    }
    opts = opts ?? AnchorProvider.defaultOptions();
    const NodeWallet = require("./nodewallet.js").default;
    const wallet = NodeWallet.local();
    return new AnchorProvider(url ?? "http://localhost:8899", wallet, opts);
  }

  /**
   * Returns a `Provider` read from the `ANCHOR_PROVIDER_URL` environment
   * variable
   *
   * (This api is for Node only.)
   */
  static env(): AnchorProvider {
    if (isBrowser) {
      throw new Error(`Provider env is not available on browser.`);
    }

    const process = require("process");
    const url = process.env.ANCHOR_PROVIDER_URL;
    if (url === undefined) {
      throw new Error("ANCHOR_PROVIDER_URL is not defined");
    }
    const options = AnchorProvider.defaultOptions();
    const NodeWallet = require("./nodewallet.js").default;
    const wallet = NodeWallet.local();

    return new AnchorProvider(url, wallet, options);
  }

  /**
   * Sends the given transaction, paid for and signed by the provider's wallet.
   *
   * @param tx      The transaction to send.
   * @param signers The signers of the transaction.
   * @param opts    Transaction confirmation options.
   */
  async sendAndConfirm(
    tx: Transaction,
    signers?: CryptoKeyPair[],
    opts?: ConfirmOptions
  ): Promise<TransactionSignature> {
    if (opts === undefined) {
      opts = this.opts;
    }

    // Versioned transactions now have first-class support,
    // so we no longer need to differentiate.
    const blockhashLifetime = (await this.rpc.getLatestBlockhash(opts).send())
      .value;

    // We don't have a helper for this yet.
    // See solana-labs/solana-web3.js#1573
    const txWithFeePayer = setTransactionFeePayer(this.wallet.address, tx);
    const txWithFeePayerAndBlockhashLifetime =
      setTransactionLifetimeUsingBlockhash(blockhashLifetime, txWithFeePayer);
    let finalTx = txWithFeePayerAndBlockhashLifetime;
    if (signers) {
      for (const signer of signers) {
        finalTx = await signTransaction(signer, finalTx);
      }
    }
    // This method will need re-implementation.
    // finalTx = await this.wallet.signTransaction(tx);

    const rawTx = finalTx.serialize();

    try {
      return await sendAndConfirmRawTransaction(this.rpc, rawTx, opts);
    } catch (err) {
      // thrown if the underlying 'confirmTransaction' encounters a failed tx
      // the 'confirmTransaction' error does not return logs so we make another rpc call to get them
      if (err instanceof ConfirmError) {
        // choose the shortest available commitment for 'getTransaction'
        // (the json RPC does not support any shorter than "confirmed" for 'getTransaction')
        // because that will see the tx sent with `sendAndConfirmRawTransaction` no matter which
        // commitment `sendAndConfirmRawTransaction` used
        const txSig = bs58.encode(finalTx.signatures?.[0] || new Uint8Array());
        const failedTx = await this.rpc
          .getTransaction(txSig, {
            commitment: "confirmed",
          })
          .send();
        if (!failedTx) {
          throw err;
        } else {
          const logs = failedTx.meta?.logMessages;
          throw !logs ? err : new SendTransactionError(err.message, logs);
        }
      } else {
        throw err;
      }
    }
  }

  /**
   * Similar to `send`, but for an array of transactions and signers.
   * All transactions need to be of the same type, it doesn't support a mix of `VersionedTransaction`s and `Transaction`s.
   *
   * @param txWithSigners Array of transactions and signers.
   * @param opts          Transaction confirmation options.
   */
  async sendAll<T extends Transaction>(
    txWithSigners: {
      tx: T;
      signers?: CryptoKeyPair[];
    }[],
    opts?: ConfirmOptions
  ): Promise<Array<TransactionSignature>> {
    if (opts === undefined) {
      opts = this.opts;
    }

    // Versioned transactions now have first-class support,
    // so we no longer need to differentiate.
    const blockhashLifetime = (await this.rpc.getLatestBlockhash(opts).send())
      .value;

    let txs = txWithSigners.map(async (r) => {
      // We don't have a helper for this yet.
      // See solana-labs/solana-web3.js#1573
      const txWithFeePayer = setTransactionFeePayer(this.wallet.address, r.tx);
      const txWithFeePayerAndBlockhashLifetime =
        setTransactionLifetimeUsingBlockhash(blockhashLifetime, txWithFeePayer);
      let finalTx = txWithFeePayerAndBlockhashLifetime;
      if (r.signers) {
        for (const signer of r.signers) {
          finalTx = await signTransaction(signer, finalTx);
        }
      }
      // finalTx = await this.wallet.signTransaction(tx);
      return finalTx;
    });

    // This method will need re-implementation.
    // const signedTxs = await this.wallet.signAllTransactions(txs);
    const signedTxs = txs;

    const sigs: TransactionSignature[] = [];

    for (let k = 0; k < txs.length; k += 1) {
      const tx = signedTxs[k];
      const rawTx = tx.serialize();

      try {
        sigs.push(await sendAndConfirmRawTransaction(this.rpc, rawTx, opts));
      } catch (err) {
        // thrown if the underlying 'confirmTransaction' encounters a failed tx
        // the 'confirmTransaction' error does not return logs so we make another rpc call to get them
        if (err instanceof ConfirmError) {
          // choose the shortest available commitment for 'getTransaction'
          // (the json RPC does not support any shorter than "confirmed" for 'getTransaction')
          // because that will see the tx sent with `sendAndConfirmRawTransaction` no matter which
          // commitment `sendAndConfirmRawTransaction` used
          const txSig = bs58.encode(tx.signatures?.[0] || new Uint8Array());
          const failedTx = await this.rpc
            .getTransaction(txSig, { commitment: "confirmed" })
            .send();
          if (!failedTx) {
            throw err;
          } else {
            const logs = failedTx.meta?.logMessages;
            throw !logs ? err : new SendTransactionError(err.message, logs);
          }
        } else {
          throw err;
        }
      }
    }

    return sigs;
  }

  /**
   * Simulates the given transaction, returning emitted logs from execution.
   *
   * @param tx      The transaction to send.
   * @param signers The signers of the transaction. If unset, the transaction
   *                will be simulated with the "sigVerify: false" option. This
   *                allows for simulation of transactions without asking the
   *                wallet for a signature.
   * @param opts    Transaction confirmation options.
   */
  async simulate(
    tx: Transaction,
    signers?: CryptoKeyPair[],
    commitment?: Commitment,
    includeAccounts?: boolean | Base58EncodedAddress[]
  ): Promise<SuccessfulTxSimulationResponse> {
    // Versioned transactions now have first-class support,
    // so we no longer need to differentiate.
    const blockhashLifetime = (await this.rpc.getLatestBlockhash(opts).send())
      .value;

    // We don't have a helper for this yet.
    // See solana-labs/solana-web3.js#1573
    const txWithFeePayer = setTransactionFeePayer(this.wallet.address, tx);
    const txWithFeePayerAndBlockhashLifetime =
      setTransactionLifetimeUsingBlockhash(blockhashLifetime, txWithFeePayer);
    let finalTx = txWithFeePayerAndBlockhashLifetime;
    if (signers) {
      for (const signer of signers) {
        finalTx = await signTransaction(signer, finalTx);
      }
    }
    // This method will need re-implementation.
    // finalTx = await this.wallet.signTransaction(tx);

    const result = await this.rpc
      .simulateTransaction(tx, { commitment })
      .send();

    if (result.value.err) {
      throw new SimulateError(result.value);
    }

    return result.value;
  }
}

class SimulateError extends Error {
  constructor(
    readonly simulationResponse: string, // We don't have error codes yet
    message?: string
  ) {
    super(message);
  }
}

export type SendTxRequest = {
  tx: Transaction;
  signers: Array<CryptoKeyPair | undefined>;
};

/**
 * Wallet interface for objects that can be used to sign provider transactions.
 * VersionedTransactions sign everything at once
 */
export interface Wallet {
  signTransaction<T extends Transaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction>(txs: T[]): Promise<T[]>;
  address: Base58EncodedAddress;
}

// Copy of Connection.sendAndConfirmRawTransaction that throws
// a better error if 'confirmTransaction` returns an error status
async function sendAndConfirmRawTransaction(
  rpc: SolanaRpc,
  rawTransaction: Buffer | Uint8Array,
  options?: ConfirmOptions
): Promise<TransactionSignature> {
  const sendOptions = options && {
    skipPreflight: options.skipPreflight,
    preflightCommitment: options.preflightCommitment || options.commitment,
  };

  const signature = await rpc
    .sendTransaction(rawTransaction, sendOptions)
    .send();

  const status = (
    await connection.confirmTransaction(
      signature,
      options && options.commitment
    )
  ).value;

  if (status.err) {
    throw new ConfirmError(
      `Raw transaction ${signature} failed (${JSON.stringify(status)})`
    );
  }

  return signature;
}

class ConfirmError extends Error {
  constructor(message?: string) {
    super(message);
  }
}

/**
 * Sets the default provider on the client.
 */
export function setProvider(provider: Provider) {
  _provider = provider;
}

/**
 * Returns the default provider being used by the client.
 */
export function getProvider(): Provider {
  if (_provider === null) {
    return AnchorProvider.local();
  }
  return _provider;
}

// Global provider used as the default when a provider is not given.
let _provider: Provider | null = null;
