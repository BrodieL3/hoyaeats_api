import axios from "axios";
import * as cheerio from "cheerio";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Interfaces
interface NutritionResponse {
  success: boolean;
  html: string;
}

export interface NutritionCollectorResult {
  success: boolean;
  totalRecipes: number;
  fetchedCount: number;
  skippedCount: number;
  errorCount: number;
  missingRecipes: number[];
  errors: string[];
}

// Configuration constants
const BASE_URL = "https://www.hoyaeats.com";
const RECIPE_ENDPOINT = `${BASE_URL}/wp-content/themes/nmc_dining/ajax-content/recipe.php?recipe=`;
const SUPABASE_BUCKET = "menus";
const CACHE_FILENAME = "nutrition_cache.json";

// Rate limiting settings
const CONCURRENT_REQUESTS = 5;
const BATCH_SIZE = 25;
const DELAY_BETWEEN_ITEMS = 200;
const DELAY_BETWEEN_BATCHES = 1000;

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "Supabase URL and Key must be provided in environment variables."
  );
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

// Global nutrition cache
let nutritionCache: Record<string, Record<string, string>> = {};

// Helper function to delay execution
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Load nutrition cache from Supabase Storage
async function loadNutritionCache(): Promise<void> {
  console.log(
    `Loading nutrition cache (${CACHE_FILENAME}) from Supabase bucket '${SUPABASE_BUCKET}'...`
  );

  try {
    // Check if the cache file exists
    const cacheExists = await fileExistsInStorage(CACHE_FILENAME);

    if (!cacheExists) {
      console.log(
        `Nutrition cache (${CACHE_FILENAME}) not found. Initializing empty cache.`
      );
      nutritionCache = {};
      return;
    }

    const { data, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .download(CACHE_FILENAME);

    if (error) {
      throw error;
    }

    if (data) {
      const cacheData = await data.text();
      nutritionCache = JSON.parse(cacheData);
      console.log(
        `Loaded ${
          Object.keys(nutritionCache).length
        } cached nutrition items from Supabase.`
      );
    } else {
      console.log(
        "No data received for nutrition cache, initializing empty cache."
      );
      nutritionCache = {};
    }
  } catch (err) {
    console.error("Error loading nutrition cache from Supabase:", err);
    console.log("Initializing empty nutrition cache due to error.");
    nutritionCache = {};
  }
}

// Save nutrition cache to Supabase Storage
async function saveNutritionCache(): Promise<void> {
  console.log(
    `Saving nutrition cache to Supabase bucket '${SUPABASE_BUCKET}' as ${CACHE_FILENAME}...`
  );

  try {
    const cacheString = JSON.stringify(nutritionCache, null, 2);
    const cacheData = Buffer.from(cacheString);

    const { data, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(CACHE_FILENAME, cacheData, {
        contentType: "application/json",
        upsert: true, // Overwrite if exists
      });

    if (error) {
      throw error;
    }

    console.log(
      `Successfully saved ${
        Object.keys(nutritionCache).length
      } nutrition items to Supabase as ${CACHE_FILENAME}`
    );
  } catch (err) {
    console.error("Error saving nutrition cache to Supabase:", err);
    throw err;
  }
}

// Check if file exists in Supabase storage
async function fileExistsInStorage(
  fileName: string,
  path: string = ""
): Promise<boolean> {
  try {
    const { data, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .createSignedUrl(`${path}${fileName}`, 60);

    if (error) {
      return false;
    }

    return !!data;
  } catch (err) {
    console.error(`Error checking if file ${fileName} exists:`, err);
    return false;
  }
}

// Check if error is an Axios error
function isAxiosError(error: any): error is Error & {
  response?: { status: number; headers: Record<string, string>; data?: any };
} {
  return error && error.isAxiosError === true;
}

// Fetch nutrition data for a single recipe
async function fetchNutrition(
  recipeId: number,
  retryCount = 0,
  refresh = false
): Promise<Record<string, string>> {
  const recipeIdStr = recipeId.toString();

  // Check cache first, but skip if refresh is true
  if (
    !refresh &&
    nutritionCache[recipeIdStr] &&
    Object.keys(nutritionCache[recipeIdStr]).length > 0
  ) {
    return { ...nutritionCache[recipeIdStr] };
  }

  try {
    const url = `${RECIPE_ENDPOINT}${recipeId}`;
    console.log(`Fetching nutrition for recipe ID: ${recipeId}`);

    const response = await axios.get<NutritionResponse>(url);
    const data = response.data;

    if (!data.success || !data.html) {
      console.warn(`Invalid response format for recipe ${recipeId}.`);
      throw new Error("Invalid response format");
    }

    const $ = cheerio.load(data.html);
    const nutrition: Record<string, string> = {};

    // Get serving size
    const servingText = $(
      "table.nutrition-facts-table thead tr.main-line th"
    ).text();
    const servingMatch = servingText.match(/Amount Per Serving\s+(.*)/i);
    if (servingMatch && servingMatch[1]) {
      nutrition["Serving Size"] = servingMatch[1].trim();
    }

    // Get main nutrition facts
    $("table.nutrition-facts-table tr.main-line").each((_, el) => {
      const text = $(el).text().trim();

      // Extract calories
      if (text.includes("Calories")) {
        const caloriesMatch = text.match(/Calories\s+(\d+)/i);
        if (caloriesMatch && caloriesMatch[1]) {
          nutrition["Calories"] = caloriesMatch[1].trim();
        }
      }

      // Extract fat
      if (text.includes("Fat")) {
        const fatMatch = text.match(/Total Fat\s+([\d\.]+\s*g)/i);
        if (fatMatch && fatMatch[1]) {
          nutrition["Fat"] = fatMatch[1].trim();
        }
      }

      // Extract carbs
      if (text.includes("Carbohydrate")) {
        const carbMatch = text.match(/Total Carbohydrate\s+([\d\.]+\s*g)/i);
        if (carbMatch && carbMatch[1]) {
          nutrition["Carbohydrate"] = carbMatch[1].trim();
        }
      }

      // Extract protein
      if (text.includes("Protein")) {
        const proteinMatch = text.match(/Protein\s+([\d\.]+\s*g)/i);
        if (proteinMatch && proteinMatch[1]) {
          nutrition["Protein"] = proteinMatch[1].trim();
        }
      }
    });

    // Get all other nutrition info
    $("table.nutrition-facts-table tr").each((_, el) => {
      const rowText = $(el).text().trim();

      // Skip rows we've already processed or header rows
      if (
        rowText.includes("Amount Per Serving") ||
        rowText.includes("Calories") ||
        rowText.includes("Total Fat") ||
        rowText.includes("Total Carbohydrate") ||
        rowText.includes("Protein") ||
        rowText.includes("% Daily Value")
      ) {
        return;
      }

      // Process other nutrients
      const cells = $(el).find("td, th");
      if (cells.length >= 2) {
        let name = $(cells[0])
          .text()
          .replace(/[\s\*\:]+$/, "")
          .trim();
        let value = $(cells[1]).text().trim();

        // Handle indented nutrients
        if (name.startsWith(" ")) {
          name = name.trim();
        }

        // Simple check to avoid empty values or placeholder text
        if (
          name &&
          value &&
          !name.includes("blank-cell") &&
          !value.includes("%") &&
          value.match(/[\d\.]+\s*[a-z]+/i)
        ) {
          // Remove potential percentage values
          value = value.replace(/\s*\d+%?$/, "").trim();
          if (value) {
            nutrition[name] = value;
          }
        }
      }
    });

    // Save to cache only if we found some data
    if (Object.keys(nutrition).length > 0) {
      console.log(`Successfully fetched nutrition for recipe ${recipeId}`);
      nutritionCache[recipeIdStr] = nutrition;
    } else {
      console.warn(`No nutrition data extracted for recipe ${recipeId}`);
    }

    return nutrition;
  } catch (err: any) {
    let errorMessage = `Error fetching nutrition for recipe ${recipeId}: `;

    if (isAxiosError(err)) {
      errorMessage += `Status: ${err.response?.status}, Message: ${err.message}`;

      if (err.response?.status === 404) {
        console.warn(`Recipe ${recipeId} not found (404). Skipping.`);
        return {};
      }

      if (err.response?.status === 429 && retryCount < 3) {
        const retryAfter = parseInt(
          err.response.headers["retry-after"] || "5",
          10
        );
        const waitTime = (retryAfter + Math.random() * 2) * 1000;
        console.log(
          `Rate limited for ${recipeId}. Waiting ${
            waitTime / 1000
          }s before retry ${retryCount + 1}`
        );
        await delay(waitTime);
        return fetchNutrition(recipeId, retryCount + 1, refresh);
      }
    } else if (err instanceof Error) {
      errorMessage += err.message;
    } else {
      errorMessage += "Unknown error occurred.";
    }

    console.error(errorMessage);
    throw new Error(errorMessage);
  }
}

// Main function to collect nutrition data for multiple recipe IDs
export async function collectNutritionData(
  recipeIds: number[],
  forceRefresh = false
): Promise<NutritionCollectorResult> {
  console.log(
    `Starting nutrition collection for ${recipeIds.length} recipe IDs...`
  );

  const result: NutritionCollectorResult = {
    success: false,
    totalRecipes: recipeIds.length,
    fetchedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    missingRecipes: [],
    errors: [],
  };

  try {
    // Load existing cache
    await loadNutritionCache();

    // Filter recipe IDs that need fetching
    const uniqueRecipeIds = Array.from(new Set(recipeIds)).filter(
      (id) => id > 0
    );
    const recipeIdsToFetch = forceRefresh
      ? uniqueRecipeIds
      : uniqueRecipeIds.filter(
          (recipeId) => !nutritionCache[recipeId.toString()]
        );

    console.log(
      `Need to fetch nutrition data for ${recipeIdsToFetch.length} out of ${uniqueRecipeIds.length} unique recipe IDs`
    );

    if (recipeIdsToFetch.length === 0) {
      console.log("All recipe IDs already have nutrition data in cache.");
      result.skippedCount = uniqueRecipeIds.length;
      result.success = true;
      return result;
    }

    // Process in batches
    const batches: number[][] = [];
    for (let i = 0; i < recipeIdsToFetch.length; i += BATCH_SIZE) {
      batches.push(recipeIdsToFetch.slice(i, i + BATCH_SIZE));
    }

    console.log(
      `Processing ${batches.length} batches with ${CONCURRENT_REQUESTS} concurrent requests each`
    );

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      console.log(
        `Processing batch ${batchIndex + 1}/${batches.length} (${
          batch.length
        } items)`
      );

      // Process each mini-batch concurrently
      const miniBatches: number[][] = [];
      for (let i = 0; i < batch.length; i += CONCURRENT_REQUESTS) {
        miniBatches.push(batch.slice(i, i + CONCURRENT_REQUESTS));
      }

      for (const miniBatch of miniBatches) {
        const promises = miniBatch.map(async (recipeId) => {
          try {
            await fetchNutrition(recipeId, 0, forceRefresh);
            result.fetchedCount++;
          } catch (err) {
            result.errorCount++;
            result.missingRecipes.push(recipeId);
            result.errors.push(
              `Recipe ${recipeId}: ${
                err instanceof Error ? err.message : "Unknown error"
              }`
            );
          }
        });

        await Promise.all(promises);
        await delay(DELAY_BETWEEN_ITEMS);
      }

      // Progress update
      const processed = result.fetchedCount + result.errorCount;
      const total = recipeIdsToFetch.length;
      const percentage = Math.round((processed / total) * 100);
      console.log(
        `Progress: ${processed}/${total} (${percentage}%) - Fetched: ${result.fetchedCount}, Errors: ${result.errorCount}`
      );

      // Delay between batches
      if (batchIndex < batches.length - 1) {
        console.log(`Waiting ${DELAY_BETWEEN_BATCHES}ms before next batch...`);
        await delay(DELAY_BETWEEN_BATCHES);
      }
    }

    // Save updated cache
    await saveNutritionCache();

    // Calculate final results
    result.skippedCount = uniqueRecipeIds.length - recipeIdsToFetch.length;
    result.success = result.errorCount < recipeIdsToFetch.length / 2; // Success if less than 50% errors

    console.log(`\n=== NUTRITION COLLECTION COMPLETED ===`);
    console.log(`Total recipe IDs: ${result.totalRecipes}`);
    console.log(`Unique recipe IDs: ${uniqueRecipeIds.length}`);
    console.log(`Successfully fetched: ${result.fetchedCount}`);
    console.log(`Skipped (already cached): ${result.skippedCount}`);
    console.log(`Errors: ${result.errorCount}`);
    console.log(
      `Missing recipes: ${
        result.missingRecipes.length > 0
          ? result.missingRecipes.join(", ")
          : "None"
      }`
    );
    console.log(
      `Cache now contains: ${Object.keys(nutritionCache).length} entries`
    );

    return result;
  } catch (error) {
    console.error("Error in nutrition collection:", error);
    result.errors.push(
      `System error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
    return result;
  }
}

// Function to collect nutrition data from buckets data file
export async function collectNutritionFromBuckets(
  bucketsDataPath: string
): Promise<NutritionCollectorResult> {
  console.log(`Loading recipe IDs from buckets data: ${bucketsDataPath}`);

  try {
    const fs = require("fs");
    const bucketsData = JSON.parse(fs.readFileSync(bucketsDataPath, "utf8"));

    // Extract all recipe IDs from buckets data
    const recipeIds: number[] = [];

    for (const locationId in bucketsData.locations) {
      const location = bucketsData.locations[locationId];
      for (const mealPeriod in location.mealPeriods) {
        for (const station in location.mealPeriods[mealPeriod].stations) {
          const itemIDs =
            location.mealPeriods[mealPeriod].stations[station].itemIDs;
          itemIDs.forEach((itemId: string) => {
            if (bucketsData.items[itemId]) {
              recipeIds.push(bucketsData.items[itemId].recipeId);
            }
          });
        }
      }
    }

    console.log(`Extracted ${recipeIds.length} recipe IDs from buckets data`);
    return await collectNutritionData(recipeIds);
  } catch (error) {
    console.error("Error loading buckets data:", error);
    throw error;
  }
}

// Function to get current cache status
export async function getCacheStatus(): Promise<{
  totalEntries: number;
  cacheSize: string;
  lastUpdated: string;
}> {
  await loadNutritionCache();

  const cacheString = JSON.stringify(nutritionCache);
  const cacheSizeKB = Math.round(Buffer.byteLength(cacheString, "utf8") / 1024);

  return {
    totalEntries: Object.keys(nutritionCache).length,
    cacheSize: `${cacheSizeKB} KB`,
    lastUpdated: new Date().toISOString(),
  };
}

// Export the main functions
export { loadNutritionCache, saveNutritionCache };
