const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const dotenv = require('dotenv');
const fetch = require('node-fetch');

dotenv.config();

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: '/ws',
  cors: {
    origin: 'http://localhost:3000', // Adjust if your frontend runs on a different origin
    methods: ['GET', 'POST'],
  },
  transports: ['websocket'], // Force WebSocket transport
});

let bondingCurveFound = false;
let raydiumFound = false;

let tokenHolders = new Map(); // Map to store holders with aggregated balances

// Get token mint address from command line or environment variable
const tokenMintAddress = process.argv[2] || process.env.TOKEN_MINT_ADDRESS;
if (!tokenMintAddress) {
  console.error('Error: Token mint address not provided. Specify as argument or in .env.');
  process.exit(1);
}
console.log(`Using token mint address: ${tokenMintAddress}`);

// Adjust the decimals to match your token's precision (e.g., USDC has 6 decimals)
const TOKEN_DECIMALS = 6;

// Function to fetch the bonding curve address and other details from the API
async function pumpStats() {
  const url = `https://frontend-api.pump.fun/coins/${tokenMintAddress}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`API responded with status: ${response.status}`);
      const errorBody = await response.text();
      console.error(`Error body: ${errorBody}`);
      return null;
    }
    const data = await response.json();
    console.log(data);
    if (data.bonding_curve) {
      console.log(`Fetched bonding curve address: ${data.bonding_curve}`);
      console.log(`Fetched Dev Addy: ${data.creator}`);
      console.log(`Fetched Twitter and CA: ${data.mint} ${data.twitter}`);
      tokenDetails = {
        bondingCurveAddress: data.bonding_curve,
        creator: data.creator,
        mint: data.mint,
        twitter: data.twitter
      };
      return tokenDetails;
    } else {
      console.error('Bonding curve address not found in API response');
      return null;
    }
  } catch (error) {
    console.error('Error fetching bonding curve address:', error);
    return null;
  }
}


// Get the bonding curve address and other details from the API
async function pump() {
  let pumpData = await pumpStats();
  return pumpData;
}

// Define pumpData as a global variable
let pumpData = null;

// Function to fetch token details and initialize pumpData
async function initializePumpData() {
  pumpData = await pump();
  if (!pumpData) {
    console.error("Failed to fetch pump data. Exiting.");
    process.exit(1);
  }
}

// Call initializePumpData on startup to ensure pumpData is ready
initializePumpData().then(() => {
  // Destructure bondingCurveAddress after pumpData is initialized
  const { bondingCurveAddress } = pumpData;

  // WebSocket connection after pumpData is initialized
  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Send the current state to the new client with additional token details
    socket.emit('initial_data', {
      holders: Array.from(tokenHolders.values()),
      pumpData: pumpData // Ensure pumpData is defined here
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
    });
  });

  // Periodic update with full fetch and incremental broadcast
  async function updateTokenHolders(bondingCurveAddress) {
    await findHolders(bondingCurveAddress);
  }

  // Set up the periodic fetch (e.g., every 5 seconds)
  setInterval(() => updateTokenHolders(bondingCurveAddress), 5000); // 5 seconds

  // Initial fetch to populate holders on startup
  updateTokenHolders(bondingCurveAddress);
});

// Fetch holders using Helius RPC with pagination
async function findHolders(bondingCurveAddress = false) {
  let page = 1;
  const newHolders = new Map();

  if (!bondingCurveAddress) {
    console.error('Unable to retrieve bonding curve address');
    // Handle this scenario as needed
  }

  // The Raydium LP address
  const raydiumAddress = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';

  while (true) {
    const response = await fetch(process.env.HELIUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'getTokenAccounts',
        id: 'helius-fetch',
        params: {
          page: page,
          limit: 1000,
          displayOptions: {},
          mint: tokenMintAddress,
        },
      }),
    });

    const data = await response.json();
    if (!data.result || data.result.token_accounts.length === 0) {
      console.log(
        `No more results after page ${page - 1}. Total holders processed: ${newHolders.size}`
      );
      break;
    }

    console.log(`Processing results from page ${page}`);
    data.result.token_accounts.forEach((account) => {
      const owner = account.owner;
      const amount = parseInt(account.amount, 10);
      const balance = parseFloat((amount / Math.pow(10, TOKEN_DECIMALS)).toFixed(TOKEN_DECIMALS));

      if (newHolders.has(owner)) {
        // Aggregate balance for the owner
        const existingHolder = newHolders.get(owner);
        existingHolder.balance += balance;
        newHolders.set(owner, existingHolder);
      } else {
        newHolders.set(owner, {
          address: owner,
          balance: balance,
        });
      }
    });

    page++;
  }

  console.log('Total unique holders after aggregation:', newHolders.size);

  // Mark the bonding curve address in newHolders
  if (bondingCurveAddress && !bondingCurveFound) {
    if (newHolders.has(bondingCurveAddress)) {
      newHolders.get(bondingCurveAddress).isBondingCurve = true;
      console.log(
        `Detected bonding curve address: ${bondingCurveAddress} with balance ${
          newHolders.get(bondingCurveAddress).balance
        }`
      );
      bondingCurveFound = true;
    } else {
      console.warn(
        `Bonding curve address ${bondingCurveAddress} not found among holders`
      );
    }
  }

  // Mark the Raydium LP address in newHolders
  if (raydiumAddress && !raydiumFound) {
    if (newHolders.has(raydiumAddress)) {
      newHolders.get(raydiumAddress).isRaydium = true;
      console.log(
        `Detected Raydium LP address: ${raydiumAddress} with balance ${
          newHolders.get(raydiumAddress).balance
        }`
      );
      raydiumFound = true;
    } else {
      console.warn(`Raydium LP address ${raydiumAddress} not found among holders`);
    }
  }

  processTokenHolderUpdates(newHolders);
}

// Compare and send incremental updates
function processTokenHolderUpdates(newHolders) {
  const added = [];
  const updated = [];
  const removed = [];

  // Check for added or updated holders
  newHolders.forEach((newHolder, address) => {
    const oldHolder = tokenHolders.get(address);
    if (!oldHolder) {
      added.push(newHolder); // New holder
    } else if (oldHolder.balance !== newHolder.balance) {
      updated.push(newHolder); // Balance change
    }
  });

  // Check for removed holders
  tokenHolders.forEach((_, address) => {
    if (!newHolders.has(address)) {
      removed.push({ address });
    }
  });

  // Update the main tokenHolders map
  tokenHolders = newHolders;

  // Send only the changes to clients
  if (added.length || updated.length || removed.length) {
    io.emit('update', { added, updated, removed });
    console.log('Updates sent to clients:', {
      addedCount: added.length,
      updatedCount: updated.length,
      removedCount: removed.length,
    });
  }
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
