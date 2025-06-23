import type { VercelRequest, VercelResponse } from "@vercel/node";
import { scrapeAllLocations } from "../hoyaeats_scheduler";
import { collectNutritionData, getCacheStatus } from "../nutrition_collector";
import type { NutritionCollectorResult } from "../nutrition_collector";

// Environment variables are automatically available from Vercel project settings
// No need for dotenv here in production

// Force dynamic route to ensure it's always server-rendered
export const dynamic = "force-dynamic";

// Helper function to extract recipe IDs from latest buckets data
async function getLatestRecipeIds(): Promise<number[]> {
  try {
    const { createClient } = await import("@supabase/supabase-js");

    const supabaseUrl = process.env.SUPABASE_URL || "";
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Supabase credentials not found");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get today's date file (the most recent one)
    const today = new Date().toISOString().split("T")[0];
    const { data, error } = await supabase.storage
      .from("menus")
      .download(`${today}.json`);

    if (error) {
      console.log(
        `No data file found for ${today}, skipping nutrition collection`
      );
      return [];
    }

    if (data) {
      const bucketsData = JSON.parse(await data.text());
      const recipeIds = new Set<number>();

      // Extract recipe IDs from the normalized structure
      if (bucketsData.items) {
        Object.values(bucketsData.items as any).forEach((item: any) => {
          if (item.recipeId > 0) {
            recipeIds.add(item.recipeId);
          }
        });
      }

      console.log(
        `Extracted ${recipeIds.size} unique recipe IDs from today's menu data`
      );
      return Array.from(recipeIds);
    }

    return [];
  } catch (error) {
    console.error("Error extracting recipe IDs:", error);
    return [];
  }
}

// Export as GET to match Vercel cron job requirements
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

  const startTime = new Date().toISOString();
  console.log(
    `Vercel Cron Job: Starting enhanced HoyaEats scrape at ${startTime}...`
  );

  let scrapeSuccess = false;
  let nutritionResult: NutritionCollectorResult | null = null;

  try {
    // Step 1: Run the main scraping process
    console.log("🍽️  Step 1: Starting menu data scrape...");
    scrapeSuccess = await scrapeAllLocations();

    if (scrapeSuccess) {
      console.log("✅ Menu scrape completed successfully");
    } else {
      console.log("⚠️  Menu scrape finished with no new data processed");
    }

    // Step 2: Get initial nutrition cache status
    console.log("\n🧬 Step 2: Checking nutrition cache status...");
    const initialStatus = await getCacheStatus();
    console.log(
      `📦 Current cache: ${initialStatus.totalEntries} entries (${initialStatus.cacheSize})`
    );

    // Step 3: Extract recipe IDs from latest scraped data
    console.log("\n🔍 Step 3: Extracting recipe IDs from latest menu data...");
    const recipeIds = await getLatestRecipeIds();

    if (recipeIds.length === 0) {
      console.log(
        "⏭️  No recipe IDs found to process, skipping nutrition collection"
      );
    } else {
      // Step 4: Run nutrition collection
      console.log(
        `\n🧬 Step 4: Starting nutrition collection for ${recipeIds.length} recipe IDs...`
      );
      nutritionResult = await collectNutritionData(recipeIds, false);

      console.log("📊 Nutrition collection results:");
      console.log(`  ✅ Successfully fetched: ${nutritionResult.fetchedCount}`);
      console.log(`  ⏭️  Skipped (cached): ${nutritionResult.skippedCount}`);
      console.log(`  ❌ Failed: ${nutritionResult.errorCount}`);

      if (nutritionResult.missingRecipes.length > 0) {
        console.log(
          `  🔍 Missing recipes: ${nutritionResult.missingRecipes
            .slice(0, 5)
            .join(", ")}${
            nutritionResult.missingRecipes.length > 5
              ? ` and ${nutritionResult.missingRecipes.length - 5} more`
              : ""
          }`
        );
      }
    }

    // Step 5: Get final cache status
    console.log("\n📈 Step 5: Final nutrition cache status...");
    const finalStatus = await getCacheStatus();
    const improvement = finalStatus.totalEntries - initialStatus.totalEntries;
    console.log(
      `📦 Final cache: ${finalStatus.totalEntries} entries (${finalStatus.cacheSize})`
    );

    if (improvement > 0) {
      console.log(`🎉 Cache improved by ${improvement} entries!`);
    }

    // Prepare response message
    const endTime = new Date().toISOString();
    const messages = [
      `Enhanced scrape completed at ${endTime}`,
      `Menu scrape: ${scrapeSuccess ? "SUCCESS" : "NO NEW DATA"}`,
    ];

    if (nutritionResult) {
      messages.push(
        `Nutrition collection: ${nutritionResult.fetchedCount} fetched, ${nutritionResult.skippedCount} cached, ${nutritionResult.errorCount} errors`
      );
      messages.push(`Cache now contains: ${finalStatus.totalEntries} entries`);
    } else {
      messages.push("Nutrition collection: SKIPPED (no new menu data)");
    }

    const responseMessage = messages.join(" | ");
    console.log(`\n🏁 ${responseMessage}`);

    // Determine response status
    if (scrapeSuccess || (nutritionResult && nutritionResult.success)) {
      response.status(200).send(responseMessage);
    } else {
      response.status(200).send(responseMessage + " | NOTE: Limited success");
    }
  } catch (error) {
    console.error("Vercel Cron Job: Error during enhanced scrape:", error);

    // Determine if the error is an object with a message property
    const errorMessage =
      error instanceof Error
        ? error.message
        : "An unknown error occurred during the enhanced scrape.";

    const failureMessage = `Enhanced scrape failed: ${errorMessage} | Menu scrape: ${
      scrapeSuccess ? "SUCCESS" : "FAILED"
    } | Nutrition: ${nutritionResult ? "PARTIAL" : "FAILED"}`;

    response.status(500).send(failureMessage);
  }
}
