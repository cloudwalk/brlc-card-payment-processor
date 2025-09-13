import { ethers } from "hardhat";
import * as fs from "fs";
import { ContractFactory, TransactionReceipt, Wallet, JsonRpcProvider, Contract } from "ethers";
import axios from "axios";

// Environment variables with defaults
const SP_REMEDIATION_FILE_PATH = process.env.SP_REMEDIATION_FILE_PATH ?? "./remediation.csv";
const SP_CASHBACK_PER_USER_FILE_PATH = process.env.SP_CASHBACK_PER_USER_FILE_PATH ?? "./cashback_per_user.csv";
const SP_OUTPUT_FILE_PATH = process.env.SP_OUTPUT_FILE_PATH ?? "./remediation_out.csv";
const SP_CASHBACK_THRESHOLD = Number(process.env.SP_CASHBACK_THRESHOLD ?? "5.0");
const SP_TOKEN_ADDRESS = process.env.SP_TOKEN_ADDRESS ?? "0x";
const SP_CONTRACT_ADDRESS = process.env.SP_CONTRACT_ADDRESS ?? "0x";
const SP_BLOCKCHAIN_CALLING_BATCH_SIZE = parseInt(process.env.SP_BLOCKCHAIN_CALLING_BATCH_SIZE ?? "100");
const SP_BLOCKCHAIN_SENDING_BATCH_SIZE = parseInt(process.env.SP_BLOCKCHAIN_SENDING_BATCH_SIZE ?? "100");
const SP_GAS_LIMIT: number = parseInt(process.env.SP_GAS_LIMIT ?? "1000000");
const SP_GAS_PRICE: number = parseInt(process.env.SP_GAS_PRICE ?? "0");
const SP_SKIP_SENDING = (process.env.SP_SKIP_SENDING ?? "true") === "true";
const SP_FAKE_TX_HASH = process.env.SP_FAKE_TX_HASH ?? "0x123";
const SP_RPC_URL = process.env.SP_RPC_URL ?? "http://localhost:7545";
const SP_PRIVATE_KEY = process.env.SP_PRIVATE_KEY ?? "0x";

if (!SP_PRIVATE_KEY) {
  console.error("❌ SP_PRIVATE_KEY environment variable is required");
  process.exit(1);
}
if (!RegExp(/^(0x)?[0-9a-fA-F]{64}$/).exec(SP_PRIVATE_KEY)) {
  console.error("❌ SP_PRIVATE_KEY must be a valid 32-byte hex string (with or without 0x prefix)");
  process.exit(1);
}
// Ensure 0x prefix for ethers
const PRIVATE_KEY = SP_PRIVATE_KEY.startsWith("0x") ? SP_PRIVATE_KEY : `0x${SP_PRIVATE_KEY}`;

interface RemediationRecord {
  id: number;
  cashback_nonce: string;
  authorizationId: string;
  user_address: string;
  user_id: string;
  initial_amount_per_nonce: bigint;
  initial_amount_per_nonce_BRLC: number;
}

interface CashbackPerUserRecord {
  id: number;
  user_address: string;
  user_id: string;
  amount_per_user_BRLC: number;
}

interface ProcessedRecord extends RemediationRecord {
  action: "Revocation" | "SkippedByCondition" | "SkippedNotEnoughBalance";
  action_result: string;
  revoked_amount: bigint;
  revoked_amount_BRLC: number;
  tx_hash: string;
  left_amount_to_revoke: bigint;
  left_amount_to_revoke_BRLC: number;
}

interface UserBalance {
  address: string;
  initial_balance: bigint;
  remaining_balance: bigint;
}

interface TransactionData {
  id: number;
  amount: bigint;
  hash: string;
}

interface TransactionResult {
  id: number;
  amount: bigint;
  hash: string;
  receipt: TransactionReceipt | null;
}

interface RPCRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: string[];
}

interface PreparedTransaction {
  signedTx: string;
  txHash: string;
}

async function main() {
  console.log("🚀 Starting cashback revocation script");
  console.log(`📄 Remediation file: ${SP_REMEDIATION_FILE_PATH}`);
  console.log(`📄 Cashback per user file: ${SP_CASHBACK_PER_USER_FILE_PATH}`);
  console.log(`📄 Output file: ${SP_OUTPUT_FILE_PATH}`);
  console.log(`🎯 Threshold: ${SP_CASHBACK_THRESHOLD} BRT`);
  console.log(`🪙 Token address: ${SP_TOKEN_ADDRESS}`);
  console.log(`📦 CashbackDistributor address: ${SP_CONTRACT_ADDRESS}`);
  console.log(`📊 Calling batch size: ${SP_BLOCKCHAIN_CALLING_BATCH_SIZE}`);
  console.log(`📊 Sending batch size: ${SP_BLOCKCHAIN_SENDING_BATCH_SIZE}`);
  console.log(`🌐 RPC URL: ${SP_RPC_URL}`);
  console.log(`⏭️ Skip sending: ${SP_SKIP_SENDING}`);

  // Initialize provider and wallet
  const provider = new JsonRpcProvider(SP_RPC_URL);
  const wallet = new Wallet(PRIVATE_KEY, provider);
  console.log(`🔑 Using wallet address: ${wallet.address}`);

  // Step a: Load data from CSV files
  console.log("\n📂 Step a: Loading CSV data...");
  const remediationRecords = loadRemediationCSV(SP_REMEDIATION_FILE_PATH);
  const cashbackPerUserRecords = loadCashbackPerUserCSV(SP_CASHBACK_PER_USER_FILE_PATH);
  console.log(`✅ Loaded ${remediationRecords.length} remediation records`);
  console.log(`✅ Loaded ${cashbackPerUserRecords.length} cashback per user records`);

  // Step b: Filter data for cashback revocation
  console.log("\n🔍 Step b: Filtering records for revocation...");
  const { processedRecords, revocationRecords } = filterRecordsForRevocation(
    remediationRecords,
    cashbackPerUserRecords,
    SP_CASHBACK_THRESHOLD
  );
  console.log(`✅ Found ${revocationRecords.length} records requiring revocation`);
  console.log(`✅ Found ${processedRecords.length - revocationRecords.length} records to skip`);

  // Step c: Prepare user addresses for balance checks
  console.log("\n👥 Step c: Preparing user addresses...");
  const userAddressSet = new Set(revocationRecords.map(record => record.user_address));
  const userAddresses = Array.from(userAddressSet);
  console.log(`✅ Found ${userAddresses.length} unique user addresses`);

  // Step d & e: Get user balances in batches
  console.log("\n💰 Step d-e: Getting user token balances...");
  const userBalances = await getUserBalances(userAddresses, SP_TOKEN_ADDRESS, provider);
  console.log(`✅ Retrieved balances for ${userBalances.length} users`);

  // Step f: Prepare and send revocation transactions
  console.log("\n🔧 Step f-g: Preparing and sending revocation transactions...");
  const transactionsData = await sendTransactions(revocationRecords, userBalances, wallet);
  console.log(`✅ Prepared and sent ${transactionsData.length} transactions`);

  // Step h: Get transaction receipts
  let transactionResults: TransactionResult[] = [];
  const tries = 3;
  for (let i = 0; i < tries; i++) {
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 10000)); // 10-second delay
    } else {
      await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay
    }
    console.log("\n📋 Step h: Getting transaction receipts...");
    transactionResults = await getTransactionReceipts(transactionsData, provider);
    console.log(`✅ Retrieved ${transactionResults.length} receipts`);
    if (transactionResults.length === transactionsData.length) {
      break;
    }
  }
  if (transactionResults.length !== transactionsData.length) {
    console.warn(
      `⚠️ Warning: Not all receipts were retrieved after ${tries} tries: ` +
      `${transactionResults.length} / ${transactionsData.length}`
    );
  }

  // Step i: Analyze receipts and update results
  console.log("\n🔍 Step i: Analyzing transaction receipts...");
  await updateRecordsWithResults(revocationRecords, transactionResults, transactionsData);
  console.log(`✅ Updated records with transaction results`);
  finalizeProcessedRecords(revocationRecords);

  // Step j: Generate output file
  console.log("\n📝 Step j: Generating output file...");
  generateOutputFile(processedRecords, SP_OUTPUT_FILE_PATH);
  console.log(`✅ Output written to: ${SP_OUTPUT_FILE_PATH}`);

  console.log("\n🎉 Script completed successfully!");
}

function loadRemediationCSV(filePath: string): RemediationRecord[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n");
  const headers = lines[0].split("\t");

  // Define expected headers based on RemediationRecord structure
  const expectedHeaders = Object.keys({} as RemediationRecord);

  // Validate that all expected headers are present
  const missingHeaders = expectedHeaders.filter(header => !headers.includes(header));
  if (missingHeaders.length > 0) {
    throw new Error(`Missing headers in ${filePath}.`);
  }

  // Create header index mapping
  const headerIndexMap = new Map<string, number>();
  headers.forEach((header, index) => {
    headerIndexMap.set(header, index);
  });

  return lines.slice(1).map((line, index) => {
    const values = line.split("\t");
    return {
      id: index + 1,
      cashback_nonce: values[headerIndexMap.get("cashback_nonce") ?? 0],
      authorizationId: values[headerIndexMap.get("authorizationId") ?? 0],
      user_address: values[headerIndexMap.get("user_address") ?? 0],
      user_id: values[headerIndexMap.get("user_id") ?? 0],
      initial_amount_per_nonce: BigInt(values[headerIndexMap.get("initial_amount_per_nonce") ?? 0]),
      initial_amount_per_nonce_BRLC: Number(values[headerIndexMap.get("initial_amount_per_nonce_BRLC") ?? 0])
    };
  });
}

function loadCashbackPerUserCSV(filePath: string): CashbackPerUserRecord[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n");
  const headers = lines[0].split("\t");

  // Define expected headers based on CashbackPerUserRecord structure
  const expectedHeaders = Object.keys({} as CashbackPerUserRecord);

  // Validate that all expected headers are present
  const missingHeaders = expectedHeaders.filter(header => !headers.includes(header));
  if (missingHeaders.length > 0) {
    throw new Error(`Missing headers in ${filePath}`);
  }

  // Create header index mapping
  const headerIndexMap = new Map<string, number>();
  headers.forEach((header, index) => {
    headerIndexMap.set(header, index);
  });

  return lines.slice(1).map((line, index) => {
    const values = line.split("\t");
    return {
      id: index + 1,
      user_address: values[headerIndexMap.get("user_address") ?? 0],
      user_id: values[headerIndexMap.get("user_id") ?? 0],
      amount_per_user_BRLC: Number(values[headerIndexMap.get("amount_per_user_BRLC") ?? 0])
    };
  });
}

function makeIndexedById<T extends { id: number }>(records: T[]): Map<number, T> {
  const indexedById = new Map<number, T>();
  records.forEach(record => {
    indexedById.set(record.id, record);
  });
  return indexedById;
}

function makeIndexedByAddress<T extends { address: string }>(records: T[]): Map<string, T> {
  const indexedByAddress = new Map<string, T>();
  records.forEach(record => {
    indexedByAddress.set(record.address.toLowerCase(), record);
  });
  return indexedByAddress;
}

function filterRecordsForRevocation(
  remediationRecords: RemediationRecord[],
  cashbackPerUserRecords: CashbackPerUserRecord[],
  threshold: number
): { processedRecords: ProcessedRecord[]; revocationRecords: ProcessedRecord[] } {
  const cashbackPerUserMap = new Map<string, CashbackPerUserRecord>();
  cashbackPerUserRecords.forEach(record => {
    cashbackPerUserMap.set(record.user_address.toLowerCase(), record);
  });

  const processedRecords: ProcessedRecord[] = [];
  const revocationRecords: ProcessedRecord[] = [];

  for (const record of remediationRecords) {
    const userCashback = cashbackPerUserMap.get(record.user_address.toLowerCase());
    const shouldRevoke = userCashback && userCashback.amount_per_user_BRLC > threshold;

    const processedRecord: ProcessedRecord = makeProcessedRecord(record);
    if (shouldRevoke) {
      processedRecord.action = "Revocation";
    } else {
      processedRecord.action = "SkippedByCondition";
    }
    processedRecords.push(processedRecord);
    if (shouldRevoke) {
      revocationRecords.push(processedRecord);
    }
  }

  return { processedRecords, revocationRecords };
}

function makeProcessedRecord(record: RemediationRecord): ProcessedRecord {
  return {
    ...record,
    action: "SkippedByCondition",
    action_result: "--",
    revoked_amount: 0n,
    revoked_amount_BRLC: 0,
    tx_hash: "--",
    left_amount_to_revoke: record.initial_amount_per_nonce,
    left_amount_to_revoke_BRLC: record.initial_amount_per_nonce_BRLC
  };
}

async function getUserBalances(
  addresses: string[],
  tokenAddress: string,
  provider: JsonRpcProvider
): Promise<UserBalance[]> {
  const tokenContract = (await ethers.getContractFactory("ERC20TokenMock"))
    .attach(tokenAddress)
    .connect(provider) as Contract;
  const balances: UserBalance[] = [];

  // Process addresses in batches for logging purposes
  for (let i = 0; i < addresses.length; i += SP_BLOCKCHAIN_CALLING_BATCH_SIZE) {
    const batchAddresses = addresses.slice(i, i + SP_BLOCKCHAIN_CALLING_BATCH_SIZE);
    console.log(
      `📞 Batch ${Math.floor(i / SP_BLOCKCHAIN_CALLING_BATCH_SIZE) + 1}: Checking ${batchAddresses.length} balances...`
    );

    const balancePromises: Promise<bigint>[] = [];

    for (const address of batchAddresses) {
      balancePromises.push(tokenContract.balanceOf(address));
    }
    const batchBalances = await Promise.all(balancePromises);
    for (let i = 0; i < batchAddresses.length; i++) {
      balances.push({
        address: batchAddresses[i],
        initial_balance: batchBalances[i],
        remaining_balance: batchBalances[i]
      });
    }
  }

  return balances;
}

function processUserBalance(
  userBalances: Map<string, UserBalance>,
  userAddress: string,
  requestedAmount: bigint
): bigint {
  const userBalance = userBalances.get(userAddress.toLowerCase());
  if (!userBalance) {
    throw new Error(`User balance not found for ${userAddress}`);
  }

  const actualAmount = userBalance.remaining_balance < requestedAmount
    ? userBalance.remaining_balance
    : requestedAmount;

  userBalance.remaining_balance -= actualAmount;
  userBalances.set(userAddress.toLowerCase(), userBalance);

  return actualAmount;
}

async function sendTransactionBatch(
  batch: PreparedTransaction[],
  batchNumber: number,
  totalBatches: number
): Promise<void> {
  console.log(`📦 Batch ${batchNumber}/${totalBatches}: Sending ${batch.length} transactions...`);

  // Prepare RPC batch request
  const rpcRequests: RPCRequest[] = batch.map((item, index) => ({
    jsonrpc: "2.0",
    id: (batchNumber - 1) * SP_BLOCKCHAIN_SENDING_BATCH_SIZE + index + 1,
    method: "eth_sendRawTransaction",
    params: [item.signedTx]
  }));

  try {
    // Send batch request (fire and forget - we already have the tx hashes)
    await axios.post(
      SP_RPC_URL,
      rpcRequests,
      {
        headers: {
          "Content-Type": "application/json"
        },
        timeout: 10000 // 10-second timeout
      }
    );
    console.log(`✅ Batch ${batchNumber}/${totalBatches} sent successfully`);
  } catch (error) {
    console.error(`⚠️ Failed to send batch ${batchNumber}, but transactions hashes are already recorded:`, error);
    // Continue anyway - we have the transaction hashes
  }
}

async function sendPreparedTransactions(preparedTransactions: PreparedTransaction[]) {
  if (preparedTransactions.length === 0) {
    return;
  }

  console.log(
    `📤 Sending ${preparedTransactions.length} transactions in batches of ${SP_BLOCKCHAIN_SENDING_BATCH_SIZE}...`
  );

  const totalBatches = Math.ceil(preparedTransactions.length / SP_BLOCKCHAIN_SENDING_BATCH_SIZE);

  for (let i = 0; i < preparedTransactions.length; i += SP_BLOCKCHAIN_SENDING_BATCH_SIZE) {
    const batch = preparedTransactions.slice(i, i + SP_BLOCKCHAIN_SENDING_BATCH_SIZE);
    const batchNumber = Math.floor(i / SP_BLOCKCHAIN_SENDING_BATCH_SIZE) + 1;

    await sendTransactionBatch(batch, batchNumber, totalBatches);

    // Add a small delay between batches to avoid overwhelming the RPC endpoint
    if (i + SP_BLOCKCHAIN_SENDING_BATCH_SIZE < preparedTransactions.length) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay
    }
  }
}

async function sendTransactions(
  revocationRecords: ProcessedRecord[],
  userBalances: UserBalance[],
  wallet: Wallet
): Promise<TransactionData[]> {
  const userBalancesIndexedByAddress = makeIndexedByAddress(userBalances);
  const contract = (await ethers.getContractFactory("CashbackDistributor"))
    .attach(SP_CONTRACT_ADDRESS)
    .connect(wallet) as Contract;
  const transactions: TransactionData[] = [];
  let nonce = await wallet.getNonce();

  const preparedTransactions: PreparedTransaction[] = [];

  // Process each revocation record
  for (const record of revocationRecords) {
    const requestedAmount = record.initial_amount_per_nonce;

    // Calculate the actual amount based on user balance
    const actualAmount = processUserBalance(
      userBalancesIndexedByAddress,
      record.user_address,
      requestedAmount
    );

    if (actualAmount > 0) {
      if (SP_SKIP_SENDING) {
        // Skip mode - just add a fake transaction
        transactions.push({
          id: record.id,
          amount: actualAmount,
          hash: SP_FAKE_TX_HASH
        });
      } else {
        // Prepare and sign the transaction
        const populatedTx = await contract.revokeCashback.populateTransaction(
          record.cashback_nonce,
          actualAmount,
          { gasLimit: SP_GAS_LIMIT, gasPrice: SP_GAS_PRICE, nonce }
        );
        const signedTx = await wallet.signTransaction(populatedTx);
        const txHash = ethers.keccak256(signedTx);
        const preparedTx: PreparedTransaction = { signedTx, txHash };

        // Add to results immediately
        transactions.push({
          id: record.id,
          amount: actualAmount,
          hash: preparedTx.txHash
        });

        preparedTransactions.push(preparedTx);
        ++nonce;
      }
    } else {
      record.action = "SkippedNotEnoughBalance";
    }
  }

  // Send all prepared transactions in batches
  if (!SP_SKIP_SENDING) {
    await sendPreparedTransactions(preparedTransactions);
  }

  return transactions;
}

async function getTransactionReceipts(
  txsData: TransactionData[],
  provider: JsonRpcProvider
): Promise<TransactionResult[]> {
  const transactionsResults: TransactionResult[] = [];

  // Process in batches for logging purposes
  for (let i = 0; i < txsData.length; i += SP_BLOCKCHAIN_CALLING_BATCH_SIZE) {
    const batchHashes = txsData.slice(i, i + SP_BLOCKCHAIN_CALLING_BATCH_SIZE).map(tx => tx.hash);
    console.log(
      `📞 Batch ${Math.floor(i / SP_BLOCKCHAIN_CALLING_BATCH_SIZE) + 1}: Checking ${batchHashes.length} receipts...`
    );

    // Create promises for all receipt calls in this batch
    const receiptPromises: Promise<TransactionReceipt | null>[] = [];
    for (const hash of batchHashes) {
      receiptPromises.push(provider.getTransactionReceipt(hash));
    }
    const batchReceipts = await Promise.all(receiptPromises);
    for (let j = 0; j < batchReceipts.length; j++) {
      const receipt = batchReceipts[j];
      if (receipt) {
        transactionsResults.push({
          id: txsData[i + j].id,
          amount: txsData[i + j].amount,
          hash: receipt.hash,
          receipt
        });
      }
    }
  }
  return transactionsResults;
}

function determineRevocationStatus(transactionResult: TransactionResult, contractFactory: ContractFactory) {
  let revocationStatus = "Unknown";

  if (transactionResult.receipt?.logs) {
    for (const log of transactionResult.receipt.logs) {
      const parsedLog = contractFactory.interface.parseLog(log);
      if (parsedLog && parsedLog.name === "RevokeCashback") {
        revocationStatus = getRevocationStatusFromCode(parsedLog.args.status.toString());
        break;
      }
    }
  }
  return revocationStatus;
}

function getRevocationStatusFromCode(code: string): string {
  switch (code) {
    case "1":
      return "Success";
    case "2":
      return "Inapplicable";
    case "3":
      return "OutOfFunds";
    case "4":
      return "OutOfAllowance";
    case "5":
      return "OutOfBalance";
    default:
      return "Unknown";
  }
}

async function updateRecordsWithResults(
  revocationRecords: ProcessedRecord[],
  transactionResults: TransactionResult[],
  transactionsData: TransactionData[]
) {
  const transactionResultsIndexedById = makeIndexedById(transactionResults);
  const transactionsDataIndexedById = makeIndexedById(transactionsData);
  const contractFactory = await ethers.getContractFactory("CashbackDistributor");
  for (const record of revocationRecords) {
    const transactionResult = transactionResultsIndexedById.get(record.id);
    const transactionData = transactionsDataIndexedById.get(record.id);
    if (transactionResult?.receipt) {
      if (transactionResult.receipt.status === 1) {
        // Transaction successful - try to parse RevokeCashback event
        record.action_result = determineRevocationStatus(transactionResult, contractFactory);
        record.revoked_amount = transactionResult.amount;
        record.revoked_amount_BRLC = (Number(transactionResult.amount) / 1000000);
        record.tx_hash = transactionResult.hash;
      } else {
        // Transaction failed
        record.action_result = "TransactionFailed";
        record.revoked_amount = 0n;
        record.revoked_amount_BRLC = 0;
        record.tx_hash = transactionResult.hash;
      }
    } else {
      // Transaction did not send
      record.action_result = "TransactionNotSent";
      record.revoked_amount = 0n;
      record.revoked_amount_BRLC = 0;
      record.tx_hash = transactionData?.hash ?? "--";
    }
  }
}

function finalizeProcessedRecords(processedRecords: ProcessedRecord[]) {
  for (const record of processedRecords) {
    if (record.action !== "Revocation") {
      record.action_result = "--";
      record.revoked_amount = 0n;
      record.revoked_amount_BRLC = 0;
      record.tx_hash = "--";
    } else if (record.action_result !== "Success") {
      record.revoked_amount = 0n;
      record.revoked_amount_BRLC = 0;
    }
    record.left_amount_to_revoke = record.initial_amount_per_nonce - record.revoked_amount;
    record.left_amount_to_revoke_BRLC = Number(record.left_amount_to_revoke) / 1000000;
  }
}

function generateOutputFile(records: ProcessedRecord[], outputPath: string): void {
  const headers = [
    "cashback_nonce",
    "authorizationId",
    "user_address",
    "user_id",
    "initial_amount_per_nonce",
    "initial_amount_per_nonce_BRLC",
    "action",
    "action_result",
    "revoked_amount",
    "revoked_amount_BRLC",
    "tx_hash",
    "left_amount_to_revoke",
    "left_amount_to_revoke_BRLC"
  ].join("\t");

  const rows = records.map(record => [
    record.cashback_nonce,
    record.authorizationId,
    record.user_address,
    record.user_id,
    record.initial_amount_per_nonce,
    record.initial_amount_per_nonce_BRLC,
    record.action,
    record.action_result,
    record.revoked_amount,
    record.revoked_amount_BRLC,
    record.tx_hash,
    record.left_amount_to_revoke,
    record.left_amount_to_revoke_BRLC
  ].join("\t"));

  const content = headers + "\n" + rows.join("\n");
  fs.writeFileSync(outputPath, content, "utf-8");
}

// Handle script errors
main().catch(error => {
  console.error("❌ Script failed:", error);
  process.exitCode = 1;
});
