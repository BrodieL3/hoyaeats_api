import type { VercelRequest, VercelResponse } from "@vercel/node";
import { scrapeAllLocations } from "../hoyaeats_scheduler";

// Environment variables are automatically available from Vercel project settings
// No need for dotenv here in production

export default async function handler(
  request: VercelRequest,
  response: VercelResponse
) {
  // --- Vercel Cron Job Security (Recommended) ---
  // Read the Vercel documentation for securing cron jobs:
  // https://vercel.com/docs/cron-jobs/security
  // Typically involves checking a secret passed in the Authorization header
  const cronSecure = process.env.CRON_SECRET;
  if (
    cronSecure && // Only check if CRON_SECRET is set
    request.headers["authorization"] !== `Bearer ${cronSecure}`
  ) {
    console.warn("Vercel Cron Job: Unauthorized access attempt.");
    return response.status(401).end("Unauthorized");
  }
  // --- End Security Check ---

  try {
    console.log("Vercel Cron Job: Starting HoyaEats scrape...");
    const success = await scrapeAllLocations();

    if (success) {
      console.log("Vercel Cron Job: Scrape completed successfully.");
      response.status(200).send("Scrape completed successfully.");
    } else {
      console.log(
        "Vercel Cron Job: Scrape finished, but no new data was processed."
      );
      response
        .status(200)
        .send("Scrape finished, but no new data was processed.");
    }
  } catch (error) {
    console.error("Vercel Cron Job: Error during scrape:", error);
    // Determine if the error is an object with a message property
    const errorMessage =
      error instanceof Error
        ? error.message
        : "An unknown error occurred during the scrape.";
    response.status(500).send(`Scrape failed: ${errorMessage}`);
  }
}
