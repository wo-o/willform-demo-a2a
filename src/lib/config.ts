import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

export function loadConfig() {
  const baseUrl = process.env.WILLFORM_A2A_URL ?? "http://localhost:3000";
  const privateKey = process.env.WALLET_PRIVATE_KEY;

  if (!privateKey) {
    console.error("WALLET_PRIVATE_KEY is required. Set it in .env or environment.");
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);

  const fetchWithPayment = wrapFetchWithPaymentFromConfig(
    fetch,
    {
      schemes: [
        {
          network: "eip155:*",
          client: new ExactEvmScheme(account),
        },
      ],
    },
  );

  return { baseUrl, walletAddress: account.address, fetchWithPayment };
}
