import * as stringify from 'json-stable-stringify';
import { JsonRpcProvider, TransactionReceipt } from '@ethersproject/providers';
import { providers, Contract, Wallet, utils, ContractInterface } from 'ethers';
import { EthAddress } from '../_types/global/GlobalTypes';
import { address } from '../utils/CheckedTypeUtils';
import { retry, RetryableError } from './retry';

// taken from ethers.js, compatible interface with web3 provider
type AsyncSendable = {
  isMetaMask?: boolean
  host?: string
  path?: string
  sendAsync?: (request: any, callback: (error: any, response: any) => void) => void
  send?: (request: any, callback: (error: any, response: any) => void) => void
}

class RequestError extends Error {
  constructor(message: string, public code: number, public data?: unknown) {
    super(message)
  }
}

interface BatchItem {
  request: { jsonrpc: '2.0'; id: number; method: string; params: unknown }
  resolve: (result: any) => void
  reject: (error: Error) => void
}

// chunks array into chunks of maximum size
// evenly distributes items among the chunks
function chunkArray<T>(items: T[], maxChunkSize: number): T[][] {
  if (maxChunkSize < 1) throw new Error('maxChunkSize must be gte 1')
  if (items.length <= maxChunkSize) return [items]

  const numChunks: number = Math.ceil(items.length / maxChunkSize)
  const chunkSize = Math.ceil(items.length / numChunks)

  return [...Array(numChunks).keys()].map(ix => items.slice(ix * chunkSize, ix * chunkSize + chunkSize))
}

class MiniRpcProvider implements AsyncSendable {
  public readonly isMetaMask: false = false
  public readonly chainId: number
  public readonly url: string
  public readonly host: string
  public readonly path: string
  public readonly batchWaitTimeMs: number

  private nextId = 1
  private batchTimeoutId: ReturnType<typeof setTimeout> | null = null
  private batch: BatchItem[] = []

  constructor(chainId: number, url: string, batchWaitTimeMs?: number) {
    this.chainId = chainId
    this.url = url
    const parsed = new URL(url)
    this.host = parsed.host
    this.path = parsed.pathname
    // how long to wait to batch calls
    this.batchWaitTimeMs = batchWaitTimeMs ?? 50
  }

  public readonly clearBatch = async () => {
    console.debug('Clearing batch', this.batch)
    const batch = this.batch
    this.batch = []
    this.batchTimeoutId = null
    let responses: Response[]
    try {
      const chunks = chunkArray(batch, 10)
      responses = await Promise.all(chunks.map(
        (chunk) => {
          return retry(() => fetch(this.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(chunk.map(item => item.request))
          }).then(response => {
            if (!response.ok) {
              console.log('Failed response status, retrying', response.status)
              throw new RetryableError();
            }
            return response
          })
            .catch(error => {
              console.error('Batch request failed, retrying', error)
              throw new RetryableError()
            }), {n: Infinity, minWait: 500, maxWait: 2500}).promise
        }
      ))
    } catch (error) {
      batch.forEach(({ reject }) => reject(new Error('Failed to send batch call')))
      return
    }

    let json
    try {
      json = (await Promise.all(responses.map(r => r.json()))).reduce((memo, arr) => memo.concat(arr), [])
    } catch (error) {
      batch.forEach(({ reject }) => reject(new Error('Failed to parse JSON response')))
      return
    }

    const byKey = batch.reduce<{ [id: number]: BatchItem }>((memo, current) => {
      memo[current.request.id] = current
      return memo
    }, {})
    for (const result of json) {
      const {
        resolve,
        reject,
        request: { method }
      } = byKey[result.id]
      if (resolve && reject) {
        if ('error' in result) {
          reject(new RequestError(result?.error?.message, result?.error?.code, result?.error?.data))
        } else if ('result' in result) {
          resolve(result.result)
        } else {
          reject(new RequestError(`Received unexpected JSON-RPC response to ${method} request.`, -32000, result))
        }
      }
    }
  }

  public readonly sendAsync = (
    request: { jsonrpc: '2.0'; id: number | string | null; method: string; params?: unknown[] | object },
    callback: (error: any, response: any) => void
  ): void => {
    this.request(request.method, request.params)
      .then(result => callback(null, { jsonrpc: '2.0', id: request.id, result }))
      .catch(error => callback(error, null))
  }

  public readonly request = async (
    method: string | { method: string; params: unknown[] },
    params?: unknown[] | object
  ): Promise<unknown> => {
    if (typeof method !== 'string') {
      return this.request(method.method, method.params)
    }
    if (method === 'eth_chainId') {
      return `0x${this.chainId.toString(16)}`
    }
    const promise = new Promise((resolve, reject) => {
      this.batch.push({
        request: {
          jsonrpc: '2.0',
          id: this.nextId++,
          method,
          params
        },
        resolve,
        reject
      })
    })
    this.batchTimeoutId = this.batchTimeoutId ?? setTimeout(this.clearBatch, this.batchWaitTimeMs)
    return promise
  }
}
import { EventEmitter } from 'events';
import { XDAI_CHAIN_ID } from '../utils/constants';

class EthereumAccountManager extends EventEmitter {
  static instance: EthereumAccountManager | null = null;

  private provider: JsonRpcProvider;
  private signer: Wallet | null;
  private rpcURL: string;
  private readonly knownAddresses: EthAddress[];

  private constructor() {
    super();

    const isProd = process.env.NODE_ENV === 'production';
    const url = isProd ? 'https://dai.poa.network' : 'http://localhost:8545';
    this.provider = new providers.Web3Provider((new MiniRpcProvider(100, url, 150)) as providers.ExternalProvider);
    this.provider.pollingInterval = 1000;
    this.signer = null;
    this.knownAddresses = [];
    const knownAddressesStr = localStorage.getItem('KNOWN_ADDRESSES');
    if (knownAddressesStr) {
      const addrStrs = JSON.parse(knownAddressesStr) as string[];
      for (const addrStr of addrStrs) {
        this.knownAddresses.push(address(addrStr));
      }
    }
  }

  static getInstance(): EthereumAccountManager {
    if (!EthereumAccountManager.instance) {
      EthereumAccountManager.instance = new EthereumAccountManager();
    }
    return EthereumAccountManager.instance;
  }

  public getRpcEndpoint(): string {
    return this.rpcURL;
  }

  public async setRpcEndpoint(url: string): Promise<void> {
    try {
      this.rpcURL = url;
      const newProvider = new providers.JsonRpcProvider(this.rpcURL);
      if (process.env.NODE_ENV === 'production') {
        if ((await newProvider.getNetwork()).chainId !== XDAI_CHAIN_ID) {
          throw new Error('not a valid xDAI RPC URL');
        }
      }
      this.provider = newProvider;
      this.provider.pollingInterval = 8000;
      if (this.signer) {
        this.signer = new Wallet(this.signer.privateKey, this.provider);
      } else {
        this.signer = null;
      }
      localStorage.setItem('XDAI_RPC_ENDPOINT', this.rpcURL);
      this.emit('ChangedRPCEndpoint');
    } catch (e) {
      console.error(`error setting rpc endpoint: ${e}`);
      this.setRpcEndpoint('https://rpc.xdaichain.com/');
      return;
    }
  }

  public async loadContract(
    contractAddress: string,
    contractABI: ContractInterface
  ): Promise<Contract> {
    if (this.signer) {
      return new Contract(contractAddress, contractABI, this.signer);
    } else {
      throw new Error('no signer found');
    }
  }

  public async loadCoreContract(): Promise<Contract> {
    const contractABI = (
      await fetch('/public/contracts/DarkForestCore.json').then((x) => x.json())
    ).abi;

    const isProd = process.env.NODE_ENV === 'production';
    const contractAddress = isProd
      ? require('../utils/prod_contract_addr').contractAddress
      : require('../utils/local_contract_addr').contractAddress;

    return this.loadContract(contractAddress, contractABI);
  }

  public getAddress(): EthAddress {
    // throws if no account has been set yet
    if (!this.signer) {
      throw new Error('account not selected yet');
    }
    return address(this.signer.address);
  }

  public getNonce(): Promise<number> {
    // throws if no account has been set yet
    if (!this.signer) {
      throw new Error('account not selected yet');
    }
    return this.provider.getTransactionCount(this.signer.address);
  }

  public setAccount(address: EthAddress): void {
    const skey = localStorage.getItem(`skey-${address}`);
    if (skey) {
      this.signer = new Wallet(skey, this.provider);
    } else {
      throw new Error('private key for address not found');
    }
  }

  public addAccount(skey: string): void {
    // throws if invalid secret key
    const addr = address(utils.computeAddress(skey));
    localStorage.setItem(`skey-${addr}`, skey);
    this.knownAddresses.push(addr);
    localStorage.setItem('KNOWN_ADDRESSES', stringify(this.knownAddresses));
  }

  public getKnownAccounts(): EthAddress[] {
    return this.knownAddresses;
  }

  public async signMessage(message: string): Promise<string> {
    if (!this.signer) {
      throw new Error('no signer yet');
    }
    return this.signer.signMessage(message);
  }

  public async getBalance(address: EthAddress): Promise<number> {
    const balanceWeiBN = await this.provider.getBalance(address);
    return parseFloat(utils.formatEther(balanceWeiBN));
  }

  public getPrivateKey(): string {
    if (!this.signer) {
      throw new Error('no signer yet');
    }
    return this.signer.privateKey;
  }

  public async waitForTransaction(txHash: string): Promise<TransactionReceipt> {
    return this.provider.waitForTransaction(txHash);
  }
}

export default EthereumAccountManager;
