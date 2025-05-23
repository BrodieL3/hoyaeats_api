import axios from "axios";
import * as cheerio from "cheerio";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Updated data model with hierarchical structure
interface FoodItem {
  name: string;
  recipeId: number; // Changed to number type
  vegetarian: boolean;
  vegan: boolean;
  glutenFree: boolean;
  nutrition: Record<string, string>; // Will be removed in normalized structure
  timeFetched: string;
}

// Normalized data model with references
interface NormalizedMenuData {
  locations: {
    [locationId: string]: {
      name: string;
      mealPeriods: {
        [mealTime: string]: {
          stations: {
            [stationName: string]: {
              itemIDs: string[];
            };
          };
        };
      };
    };
  };
  items: {
    [itemID: string]: {
      name: string;
      recipeId: number; // Changed to number type
      vegetarian: boolean;
      vegan: boolean;
      glutenFree: boolean;
      timeFetched: string;
    };
  };
  date: string;
  lastUpdated: string;
}

// Keeping the old interface for backward compatibility during data collection
interface MenuData {
  locations: {
    [locationId: string]: {
      name: string;
      days: {
        [date: string]: {
          mealPeriods: {
            [mealTime: string]: {
              stations: {
                [stationName: string]: {
                  items: FoodItem[];
                  itemIDs: string[];
                };
              };
            };
          };
        };
      };
    };
  };
  lastUpdated: string;
}

interface NutritionResponse {
  success: boolean;
  html: string;
}

const BASE_URL = "https://www.hoyaeats.com";
const RECIPE_ENDPOINT = `${BASE_URL}/wp-content/themes/nmc_dining/ajax-content/recipe.php?recipe=`;
const LOCATIONS = [
  "fresh-food-company",
  "leo-mkt-5spice",
  "leo-mkt-olive-branch",
  "leo-mkt-whisk",
  "leo-mkt-bodega",
  "leo-mkt-sazon",
  "leo-mkt-launch",
  "mccourt",
  "hoya-court-chop-chop",
  "royal-jacket-deli",
  "epicurean-pizza",
  "epi-noodle-bar",
  "epicurean-and-company",
];

// Output details (No longer local files)
const SUPABASE_BUCKET = "menus";
const CACHE_FILENAME = "nutrition_cache.json";

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "Supabase URL and Key must be provided in environment variables."
  );
}
const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

// Optimized rate limiting settings
const CONCURRENT_REQUESTS = 5; // Process 5 requests in parallel
const BATCH_SIZE = 25; // Process 25 items at a time
const DELAY_BETWEEN_ITEMS = 200; // 200ms between items
const DELAY_BETWEEN_BATCHES = 1000; // 1 second between batches
const DELAY_BETWEEN_LOCATIONS = 500; // 0.5 second between location fetches
const DELAY_BETWEEN_DAYS = 1000; // 1 second between days

// Cache for nutrition data - will be loaded from Supabase
let nutritionCache: Record<string, Record<string, string>> = {};

// Helper function to delay execution
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper function to get dates for next 7 days
function getNextWeekDates(): string[] {
  const dates: string[] = [];
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    dates.push(date.toISOString().split("T")[0]); // Format: YYYY-MM-DD
  }

  console.log(`Getting menu for the next 7 days: ${dates.join(", ")}`);
  return dates;
}

// Load nutrition cache from Supabase Storage
async function loadNutritionCache() {
  console.log(
    `Attempting to load nutrition cache (${CACHE_FILENAME}) from Supabase bucket '${SUPABASE_BUCKET}'...`
  );
  try {
    // First check if the cache file exists
    const cacheExists = await fileExistsInStorage(CACHE_FILENAME);

    if (!cacheExists) {
      console.log(
        `Nutrition cache (${CACHE_FILENAME}) not found in Supabase. Initializing empty cache.`
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
    nutritionCache = {}; // Initialize empty cache on error
  }
}

// Save nutrition cache directly to Supabase Storage
async function saveNutritionCache() {
  console.log(
    `Attempting to save nutrition cache to Supabase bucket '${SUPABASE_BUCKET}' as ${CACHE_FILENAME}...`
  );
  try {
    const cacheString = JSON.stringify(nutritionCache, null, 2);
    // Vercel environment might require Buffer
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
    return data;
  } catch (err) {
    console.error("Error saving nutrition cache to Supabase:", err);
    throw err; // Re-throw error to indicate failure if needed
  }
}

// Upload data directly to Supabase storage
async function uploadToSupabase(
  dataToUpload: string | Buffer,
  fileName: string,
  contentType: string = "application/json"
) {
  console.log(
    `Uploading ${fileName} to Supabase bucket '${SUPABASE_BUCKET}'...`
  );
  try {
    // Check if file already exists
    const fileExists = await fileExistsInStorage(fileName);

    if (fileExists) {
      console.log(
        `File ${fileName} already exists in storage. Updating content...`
      );
    } else {
      console.log(`File ${fileName} does not exist yet. Creating new file...`);
    }

    const { data, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(fileName, dataToUpload, {
        contentType: contentType,
        upsert: true, // Overwrite if exists
      });

    if (error) {
      throw error;
    }

    console.log(`Successfully uploaded ${fileName} to Supabase storage`);
    return data;
  } catch (error) {
    console.error(`Error uploading ${fileName} to Supabase:`, error);
    throw error; // Re-throw error
  }
}

// Fix the fetchLocationPage function to correctly access tab content
async function fetchLocationPage(
  location: string,
  date: string
): Promise<{
  mealPeriods: {
    [mealTime: string]: {
      stations: {
        [stationName: string]: {
          itemIDs: string[];
          items: FoodItem[]; // Keeping for backward compatibility during collection
        };
      };
    };
  };
}> {
  const url = `${BASE_URL}/locations/${location}/?date=${date}`;
  console.log(`Fetching URL: ${url}`);

  try {
    const response = await axios.get(url);
    const $ = cheerio.load(response.data as string);

    // Create data structure for this location/date
    const result: {
      mealPeriods: {
        [mealTime: string]: {
          stations: {
            [stationName: string]: {
              itemIDs: string[];
              items: FoodItem[];
            };
          };
        };
      };
    } = {
      mealPeriods: {},
    };

    const timeFetched = new Date().toISOString();

    // First, determine all available meal periods for this location/date
    const mealPeriods: Record<string, string> = {};

    // Map each tab to its meal period (Breakfast, Lunch, Dinner, etc.)
    $(".c-tabs-nav__link").each((index, el) => {
      const mealPeriod = $(el).find(".c-tabs-nav__link-inner").text().trim();
      if (mealPeriod) {
        // Get the aria-controls attribute which points to the tab content ID
        const tabContentId = $(el).attr("aria-controls") || "";
        if (tabContentId) {
          mealPeriods[tabContentId] = mealPeriod;
          console.log(
            `Found meal period tab: ${mealPeriod} with content ID: ${tabContentId}`
          );
        }
      }
    });

    // If no tabs found, check for section headings
    if (Object.keys(mealPeriods).length === 0) {
      $(".menu-section-title, h2.f-hbold, h3.f-hbold").each((index, el) => {
        const heading = $(el).text().trim();
        if (
          heading &&
          !heading.includes("Menu") &&
          !heading.includes("Options")
        ) {
          const sectionId = `section-${index}`;
          mealPeriods[sectionId] = heading;
          console.log(`Found section heading: ${heading}`);
        }
      });
    }

    // Default meal time if we can't find any structure
    const defaultMealTime = location.includes("breakfast")
      ? "Breakfast"
      : location.includes("lunch")
      ? "Lunch"
      : location.includes("dinner")
      ? "Dinner"
      : "All Day";

    // If still no meal periods found, use default
    if (Object.keys(mealPeriods).length === 0) {
      mealPeriods["default"] = defaultMealTime;
      console.log(`No meal periods found, using default: ${defaultMealTime}`);
    }

    // Process each meal period
    for (const [tabId, mealTime] of Object.entries(mealPeriods)) {
      console.log(`Processing meal period: ${mealTime}`);

      // Initialize meal period in result
      if (!result.mealPeriods[mealTime]) {
        result.mealPeriods[mealTime] = { stations: {} };
      }

      let tabContent;

      // Select the appropriate content based on tab ID or section
      if (tabId !== "default" && !tabId.startsWith("section-")) {
        // It's a tab content ID (like tabinfo-1)
        tabContent = $(`#${tabId}`);
        console.log(
          `Selecting tab content with ID #${tabId}: found ${
            tabContent.length ? "yes" : "no"
          }`
        );
      } else if (tabId.startsWith("section-")) {
        // It's a section heading
        const sectionIndex = parseInt(tabId.replace("section-", ""));
        const sections = $(
          ".menu-section-title, h2.f-hbold, h3.f-hbold"
        ).toArray();
        if (sections[sectionIndex]) {
          tabContent = $(sections[sectionIndex]).next(
            ".menu-category-list, .menu-items-wrapper"
          );
        }
      } else {
        // Default - get all food items
        tabContent = $("body");
      }

      // If we couldn't find the tab content, use the whole document
      if (!tabContent || tabContent.length === 0) {
        console.log(
          `Couldn't find specific content for ${mealTime}, using whole document`
        );
        tabContent = $("body");
      }

      const menuItems = tabContent.find("a.show-nutrition");
      console.log(`Found ${menuItems.length} food items for ${mealTime}`);

      // Process all food items in this tab/section
      menuItems.each((_, el) => {
        const element = $(el);
        const name = element.text().trim();
        const recipeIdStr = element.attr("data-recipe") || "";
        const recipeId = parseInt(recipeIdStr) || 0; // Convert to number, default to 0 if invalid
        const classList = element.attr("class") || "";

        const vegetarian = classList.includes("prop-vegetarian");
        const vegan = classList.includes("prop-vegan");
        const glutenFree = classList.includes("prop-made_without_gluten");

        // Find the station name
        const stationButton = element
          .closest(".menu-station")
          .find("button.toggle-menu-station-data");
        const station = stationButton.length
          ? stationButton.text().trim()
          : "Unknown";

        // Initialize station in result if it doesn't exist
        if (!result.mealPeriods[mealTime].stations[station]) {
          result.mealPeriods[mealTime].stations[station] = {
            items: [],
            itemIDs: [],
          };
        }

        // Create the food item
        const foodItem: FoodItem = {
          name,
          recipeId,
          vegetarian,
          vegan,
          glutenFree,
          nutrition: {},
          timeFetched,
        };

        // Add the food item to its station within the meal period
        result.mealPeriods[mealTime].stations[station].items.push(foodItem);

        // Generate and add the item ID
        const itemID = generateSlug(name, recipeIdStr);
        result.mealPeriods[mealTime].stations[station].itemIDs.push(itemID);
      });
    }

    // If we still didn't find any items, try one more approach
    if (Object.keys(result.mealPeriods).length === 0) {
      console.log(
        "No items found with regular approaches, trying final fallback"
      );

      // Final fallback: get all show-nutrition links regardless of structure
      const allItems = $("a.show-nutrition");
      console.log(`Final fallback found ${allItems.length} total food items`);

      if (allItems.length > 0) {
        // Use the first meal period or default
        const fallbackMealTime =
          Object.values(mealPeriods)[0] || defaultMealTime;
        result.mealPeriods[fallbackMealTime] = { stations: {} };

        // Group items by station
        const stationItems: Record<
          string,
          { items: FoodItem[]; itemIDs: string[] }
        > = {};

        allItems.each((_, el) => {
          const element = $(el);
          const name = element.text().trim();
          const recipeIdStr = element.attr("data-recipe") || "";
          const recipeId = parseInt(recipeIdStr) || 0; // Convert to number
          const classList = element.attr("class") || "";

          const vegetarian = classList.includes("prop-vegetarian");
          const vegan = classList.includes("prop-vegan");
          const glutenFree = classList.includes("prop-made_without_gluten");

          const stationButton = element
            .closest(".menu-station")
            .find("button.toggle-menu-station-data");
          const station = stationButton.length
            ? stationButton.text().trim()
            : "Unknown";

          if (!stationItems[station]) {
            stationItems[station] = { items: [], itemIDs: [] };
          }

          // Create the food item
          const foodItem: FoodItem = {
            name,
            recipeId,
            vegetarian,
            vegan,
            glutenFree,
            nutrition: {},
            timeFetched,
          };

          stationItems[station].items.push(foodItem);

          // Generate and add the item ID
          const itemID = generateSlug(name, recipeIdStr);
          stationItems[station].itemIDs.push(itemID);
        });

        // Add stations to the result
        for (const [station, stationData] of Object.entries(stationItems)) {
          result.mealPeriods[fallbackMealTime].stations[station] = stationData;
        }
      }
    }

    // Count total items
    let totalItems = 0;
    for (const mealPeriod of Object.values(result.mealPeriods)) {
      for (const station of Object.values(mealPeriod.stations)) {
        totalItems += station.items.length;
      }
    }

    console.log(
      `Found ${totalItems} items at ${location} for ${date} across ${
        Object.keys(result.mealPeriods).length
      } meal periods`
    );
    return result;
  } catch (error) {
    console.error(`Error fetching menu for ${location} on ${date}:`, error);
    return { mealPeriods: {} };
  }
}

// Add this function before the fetchNutrition function
function isAxiosError(error: any): error is Error & {
  response?: { status: number; headers: Record<string, string>; data?: any };
} {
  return error && error.isAxiosError === true;
}

async function fetchNutrition(
  recipeId: number, // Changed to number type
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
    // Return a copy to prevent accidental modification of the cache
    return { ...nutritionCache[recipeIdStr] };
  }

  try {
    const url = `${RECIPE_ENDPOINT}${recipeId}`;
    console.log(`Fetching nutrition for recipe ID: ${recipeId}`); // Added log
    const response = await axios.get<NutritionResponse>(url);
    const data = response.data;

    if (!data.success || !data.html) {
      console.warn(
        `Invalid response format for recipe ${recipeId}. Response:`,
        data
      ); // Added log
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

    // Get calories
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
        rowText.includes("% Daily Value") // Skip header
      ) {
        return;
      }

      // Process other nutrients more robustly
      const cells = $(el).find("td, th"); // Get both th and td elements within the row
      if (cells.length >= 2) {
        let name = $(cells[0])
          .text()
          .replace(/[\s\*\:]+$/, "")
          .trim(); // Clean name
        let value = $(cells[1]).text().trim();

        // Handle indented nutrients (like Saturated Fat under Total Fat)
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
          // Remove potential percentage values that might be included in the value
          value = value.replace(/\s*\d+%?$/, "").trim();
          if (value) {
            // Ensure value is not empty after cleaning
            nutrition[name] = value;
          }
        }
      }
    });

    // Save to cache only if we found some data
    if (Object.keys(nutrition).length > 0) {
      console.log(`Fetched nutrition for recipe ${recipeId}:`, nutrition); // Added log
      nutritionCache[recipeIdStr] = nutrition;
    } else {
      console.warn(
        `No nutrition data extracted for recipe ${recipeId}. HTML head:`,
        data.html.substring(0, 200)
      );
    }
    return nutrition;
  } catch (err: any) {
    // Improved error logging and handling
    let errorMessage = `Error fetching nutrition for recipe ${recipeId}: `;
    if (isAxiosError(err)) {
      errorMessage += `Status: ${err.response?.status}, Message: ${err.message}`;
      if (err.response?.status === 404) {
        console.warn(`Recipe ${recipeId} not found (404). Skipping.`);
        return {}; // Return empty object for 404
      }
      if (err.response?.status === 429 && retryCount < 3) {
        const retryAfter = parseInt(
          err.response.headers["retry-after"] || "5",
          10
        );
        const waitTime = (retryAfter + Math.random() * 2) * 1000;
        console.log(
          `Rate limited fetching nutrition for ${recipeId}. Waiting ${
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
    console.error(errorMessage, err);
    return {}; // Return empty object on error
  }
}

// Create a batch processor for nutrition data
async function processNutritionData(
  menuData: MenuData,
  itemsMap: Record<string, any>,
  concurrency = CONCURRENT_REQUESTS
): Promise<void> {
  // Collect all unique recipe IDs that need nutrition data from both structures
  const recipesToFetchSet = new Set<number>();

  // Traverse the menu structure
  Object.values(menuData.locations).forEach((location) => {
    Object.values(location.days).forEach((day) => {
      Object.values(day.mealPeriods).forEach((mealPeriod) => {
        Object.values(mealPeriod.stations).forEach((station) => {
          station.items.forEach((item) => {
            // Add if recipeId exists and is not already cached
            if (item.recipeId && !nutritionCache[item.recipeId.toString()]) {
              recipesToFetchSet.add(item.recipeId);
            }
          });
        });
      });
    });
  });

  // Check items in the normalized structure (itemsMap)
  Object.values(itemsMap).forEach((item) => {
    if (item.recipeId && !nutritionCache[item.recipeId.toString()]) {
      recipesToFetchSet.add(item.recipeId);
    }
  });

  const recipesToFetch = Array.from(recipesToFetchSet);
  console.log(
    `Need to fetch nutrition data for ${recipesToFetch.length} unique items (not already cached).`
  );

  if (recipesToFetch.length === 0) {
    console.log("No new nutrition data needs to be fetched.");
    return;
  }

  // Process in batches with controlled concurrency
  const batches: number[][] = [];
  for (let i = 0; i < recipesToFetch.length; i += BATCH_SIZE) {
    batches.push(recipesToFetch.slice(i, i + BATCH_SIZE));
  }

  let fetchedCount = 0;
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    console.log(
      `Processing nutrition batch ${batchIndex + 1} of ${
        batches.length
      } (Size: ${batch.length})`
    );

    // Process each mini-batch concurrently
    const miniBatches: number[][] = [];
    for (let i = 0; i < batch.length; i += concurrency) {
      miniBatches.push(batch.slice(i, i + concurrency));
    }

    for (const miniBatch of miniBatches) {
      await Promise.all(
        miniBatch.map(async (recipeId) => {
          try {
            // Fetch nutrition (will update nutritionCache inside)
            await fetchNutrition(recipeId, 0, true);
            fetchedCount++;
          } catch (err) {
            // Error is already logged in fetchNutrition
          }
        })
      );

      // Small delay between mini-batches
      await delay(DELAY_BETWEEN_ITEMS);
    }
    console.log(
      `Finished processing mini-batches for batch ${
        batchIndex + 1
      }. Fetched ${fetchedCount} items so far.`
    );

    // Delay between larger batches
    if (batchIndex < batches.length - 1) {
      console.log(
        `Waiting ${DELAY_BETWEEN_BATCHES / 1000}s before next batch...`
      );
      await delay(DELAY_BETWEEN_BATCHES);
    }
  }

  console.log(
    `Finished fetching nutrition data. Total items fetched in this run: ${fetchedCount}`
  );
}

// Check which dates need to be generated by checking file existence in Supabase Storage
async function getDatesToProcess(allDates: string[]): Promise<string[]> {
  console.log("Checking Supabase Storage for existing date files...");
  try {
    const existingDatesSet = new Set<string>();

    // Check each date file individually
    for (const date of allDates) {
      const fileName = `${date}.json`;
      const exists = await fileExistsInStorage(fileName);

      if (exists) {
        existingDatesSet.add(date);
        console.log(`File for date ${date} already exists in storage.`);
      }
    }

    const datesToProcess = allDates.filter(
      (date) => !existingDatesSet.has(date)
    );

    console.log(
      `Found ${existingDatesSet.size} existing date files in Supabase Storage.`
    );
    console.log(
      `Need to generate ${
        datesToProcess.length
      } new date files: [${datesToProcess.join(", ")}]`
    );

    return datesToProcess;
  } catch (err) {
    console.error("Unexpected error checking existing dates in Supabase:", err);
    console.warn("Proceeding to generate for all dates due to error.");
    return allDates; // Process all dates if there's an unexpected error
  }
}

async function scrapeAllLocations(): Promise<boolean> {
  console.log(`Starting HoyaEats scrape at ${new Date().toISOString()}`);

  // Load nutrition cache from Supabase first
  await loadNutritionCache();

  // Get all dates for the next week
  const allDates = getNextWeekDates();

  // Check Supabase Storage for which dates we need to process
  const datesToProcess = await getDatesToProcess(allDates);

  let processedAnyData = false;

  if (datesToProcess.length === 0) {
    console.log(
      "All required date files already exist in Supabase Storage. No new menu data to process."
    );
    // Still process nutrition data for existing items in the cache
    await processAllNutritionData();
    // Save the updated nutrition cache
    await saveNutritionCache();
    return false; // Indicate no new data was processed
  }

  // Process data for each date that needs processing
  for (const date of datesToProcess) {
    console.log(`--- Processing menu for date: ${date} ---`);

    // Initialize menu data structure for this date
    const menuData: MenuData = {
      locations: {},
      lastUpdated: new Date().toISOString(),
    };

    // Items map for normalized structure
    const itemsMap: Record<string, any> = {};

    // Process each location for this date
    for (const locationId of LOCATIONS) {
      console.log(`Fetching food items from ${locationId} for ${date}...`);

      // Initialize location in menu data
      menuData.locations[locationId] = {
        name: locationId
          .replace(/-/g, " ")
          .replace(/\b\w/g, (l) => l.toUpperCase()), // Simple title case
        days: {},
      };

      // Fetch location data for this date
      const locationData = await fetchLocationPage(locationId, date);

      // Add this day's data to the menu structure
      if (Object.keys(locationData.mealPeriods).length > 0) {
        menuData.locations[locationId].days[date] = locationData;
        processedAnyData = true; // Mark that we found data for this date

        // Add each food item to the centralized items map
        Object.values(locationData.mealPeriods).forEach((mealPeriod) => {
          Object.values(mealPeriod.stations).forEach((station) => {
            station.items.forEach((item, index) => {
              const itemID = station.itemIDs[index];
              // Only add if not already in the map to prevent duplicates
              if (!itemsMap[itemID]) {
                // Create a copy of the item without the nutrition field
                const { nutrition, ...itemWithoutNutrition } = item;
                itemsMap[itemID] = itemWithoutNutrition;
              }
            });
          });
        });
      } else {
        console.log(
          `No meal periods found for ${locationId} on ${date}. Skipping.`
        );
      }

      // Wait between locations
      if (locationId !== LOCATIONS[LOCATIONS.length - 1]) {
        await delay(DELAY_BETWEEN_LOCATIONS);
      }
    }

    // If no data was processed for any location on this date, skip nutrition and saving
    if (!processedAnyData) {
      console.log(
        `No menu data found for any location on ${date}. Skipping nutrition processing and saving for this date.`
      );
      continue; // Move to the next date
    }

    // Process nutrition data for all items collected for this date
    await processNutritionData(menuData, itemsMap);

    // Create normalized structure for this date
    const normalizedMenuData: NormalizedMenuData = {
      locations: {},
      items: {}, // Will be populated below
      date,
      lastUpdated: new Date().toISOString(),
    };

    // Populate the normalized structure
    Object.entries(menuData.locations).forEach(([locationId, location]) => {
      const dateData = location.days[date];
      if (!dateData || Object.keys(dateData.mealPeriods).length === 0) {
        // Skip locations if they had no data for this date in this structure
        return;
      }

      normalizedMenuData.locations[locationId] = {
        name: location.name,
        mealPeriods: {},
      };

      Object.entries(dateData.mealPeriods).forEach(([mealTime, mealData]) => {
        if (Object.keys(mealData.stations).length === 0) {
          // Skip empty meal periods
          return;
        }

        normalizedMenuData.locations[locationId].mealPeriods[mealTime] = {
          stations: {},
        };

        Object.entries(mealData.stations).forEach(
          ([stationName, stationData]) => {
            if (stationData.itemIDs && stationData.itemIDs.length > 0) {
              normalizedMenuData.locations[locationId].mealPeriods[
                mealTime
              ].stations[stationName] = {
                itemIDs: stationData.itemIDs,
              };
            } else if (stationData.items && stationData.items.length > 0) {
              // Fallback: If itemIDs is missing, generate them from items
              console.warn(
                `Generating missing itemIDs for ${locationId} -> ${mealTime} -> ${stationName} on ${date}`
              );
              const itemIDs = stationData.items.map((item) =>
                generateSlug(item.name, item.recipeId.toString())
              );
              normalizedMenuData.locations[locationId].mealPeriods[
                mealTime
              ].stations[stationName] = {
                itemIDs: itemIDs,
              };
            }
            // If both items and itemIDs are empty/missing, the station won't be added, which is correct.
          }
        );

        // Clean up empty meal periods if all stations ended up empty
        if (
          Object.keys(
            normalizedMenuData.locations[locationId].mealPeriods[mealTime]
              .stations
          ).length === 0
        ) {
          delete normalizedMenuData.locations[locationId].mealPeriods[mealTime];
        }
      });

      // Clean up empty locations if all meal periods ended up empty
      if (
        Object.keys(normalizedMenuData.locations[locationId].mealPeriods)
          .length === 0
      ) {
        delete normalizedMenuData.locations[locationId];
      }
    });

    // Add items with updated nutrition from cache
    Object.keys(itemsMap).forEach((itemID) => {
      const item = itemsMap[itemID];
      const recipeIdStr = item.recipeId?.toString();
      const cachedNutrition = recipeIdStr
        ? nutritionCache[recipeIdStr]
        : undefined;

      normalizedMenuData.items[itemID] = {
        ...item,
        // Optionally add nutrition back if needed, otherwise keep it separate
        // nutrition: cachedNutrition || {},
      };
    });

    // Save the normalized results for this date directly to Supabase
    const dateFileName = `${date}.json`;
    try {
      // Check if file already exists in storage
      const fileExists = await fileExistsInStorage(dateFileName);

      if (fileExists) {
        console.log(
          `File ${dateFileName} already exists in storage. Updating with new data...`
        );
      } else {
        console.log(`Creating new file ${dateFileName} in storage...`);
      }

      const jsonDataString = JSON.stringify(normalizedMenuData, null, 2);
      const jsonDataBuffer = Buffer.from(jsonDataString); // Use Buffer
      await uploadToSupabase(jsonDataBuffer, dateFileName, "application/json");
      console.log(`Saved menu data for ${date} directly to Supabase.`);
    } catch (error) {
      console.error(`Failed to upload ${dateFileName} to Supabase`, error);
      // Decide if you want to stop the whole process or continue with the next date
    }

    // Wait between days if processing multiple dates
    if (date !== datesToProcess[datesToProcess.length - 1]) {
      await delay(DELAY_BETWEEN_DAYS);
    }
  } // End loop over datesToProcess

  // Process any remaining nutrition data (includes items from all dates)
  await processAllNutritionData();

  // Always save the updated nutrition cache at the end of the process
  await saveNutritionCache();

  console.log(`Scrape completed at ${new Date().toISOString()}`);
  console.log(`Processed ${datesToProcess.length} days of menu data.`);

  return processedAnyData; // Return true if any new data was processed across all dates
}

// Helper function to generate a slug from a food item name
function generateSlug(name: string, recipeId: string): string {
  // Start with the name, convert to lowercase
  let slug = name
    .toLowerCase()
    // Replace spaces and special characters with hyphens
    .replace(/[^a-z0-9]+/g, "-")
    // Remove leading and trailing hyphens
    .replace(/^-+|-+$/g, "")
    // Limit length
    .substring(0, 50);

  // Add part of the recipeId for uniqueness if available
  if (recipeId && recipeId !== "0") {
    // Check recipeId is valid
    // Take the last 6 characters of the recipe ID to ensure uniqueness
    const idSuffix = recipeId.substring(Math.max(0, recipeId.length - 6));
    slug = `${slug}-${idSuffix}`;
  } else {
    // If no valid recipeId, maybe add a short hash of the name for more uniqueness?
    // Example: const nameHash = require('crypto').createHash('sha1').update(name).digest('hex').substring(0, 6);
    // slug = `${slug}-${nameHash}`;
    // For now, just use the name slug if recipeId is missing/invalid
  }

  // Ensure slug is not empty
  if (!slug) {
    return `item-${recipeId || Math.random().toString(36).substring(2, 8)}`;
  }

  return slug;
}

// Utility function to check if a file exists in Supabase storage
async function fileExistsInStorage(
  fileName: string,
  path: string = ""
): Promise<boolean> {
  try {
    // Get the head of the file to check if it exists (returns metadata without downloading)
    const { data, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .createSignedUrl(`${path}${fileName}`, 60); // 60 seconds expiry

    if (error) {
      // If there's an error, the file likely doesn't exist
      console.log(
        `File ${fileName} doesn't exist in storage: ${error.message}`
      );
      return false;
    }

    // If we get back data with a URL, the file exists
    return !!data;
  } catch (err) {
    console.error(`Error checking if file ${fileName} exists:`, err);
    return false; // Assume file doesn't exist if there's an error
  }
}

// Process nutrition data for all items collected for all dates
async function processAllNutritionData(): Promise<void> {
  console.log(
    "Processing nutrition data for all items in cache and locations..."
  );

  try {
    // Create a set to track all unique recipe IDs
    const allRecipeIds = new Set<number>();

    // Add all recipe IDs from the nutrition cache for processing
    Object.keys(nutritionCache).forEach((recipeIdStr) => {
      const recipeId = parseInt(recipeIdStr);
      if (!isNaN(recipeId) && recipeId > 0) {
        allRecipeIds.add(recipeId);
      }
    });

    // Additionally, scan all locations for the next 7 days to find new recipe IDs
    const dates = getNextWeekDates();
    for (const locationId of LOCATIONS) {
      for (const date of dates) {
        try {
          console.log(
            `Scanning ${locationId} on ${date} for new recipe IDs...`
          );
          const locationData = await fetchLocationPage(locationId, date);

          // Extract recipe IDs from all meal periods, stations, and items
          Object.values(locationData.mealPeriods).forEach((mealPeriod) => {
            Object.values(mealPeriod.stations).forEach((station) => {
              station.items.forEach((item) => {
                if (item.recipeId > 0) {
                  allRecipeIds.add(item.recipeId);
                }
              });
            });
          });
        } catch (err) {
          console.error(`Error scanning ${locationId} on ${date}:`, err);
          // Continue with next location/date even if one fails
        }

        // Short delay between date fetches to avoid rate limiting
        await delay(500);
      }
    }

    console.log(
      `Found ${allRecipeIds.size} unique recipe IDs to check for nutrition data.`
    );

    // Convert to array for processing
    const recipeIdsArray = Array.from(allRecipeIds);

    // Process in batches with the same settings as regular nutrition processing
    const batches: number[][] = [];
    for (let i = 0; i < recipeIdsArray.length; i += BATCH_SIZE) {
      batches.push(recipeIdsArray.slice(i, i + BATCH_SIZE));
    }

    let fetchedCount = 0;
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      console.log(
        `Processing nutrition batch ${batchIndex + 1} of ${
          batches.length
        } (Size: ${batch.length})`
      );

      // Process each mini-batch concurrently
      const miniBatches: number[][] = [];
      for (let i = 0; i < batch.length; i += CONCURRENT_REQUESTS) {
        miniBatches.push(batch.slice(i, i + CONCURRENT_REQUESTS));
      }

      for (const miniBatch of miniBatches) {
        await Promise.all(
          miniBatch.map(async (recipeId) => {
            try {
              // Force refresh by setting refresh=true
              await fetchNutrition(recipeId, 0, true);
              fetchedCount++;
            } catch (err) {
              // Error is already logged in fetchNutrition
            }
          })
        );

        // Small delay between mini-batches
        await delay(DELAY_BETWEEN_ITEMS);
      }

      console.log(
        `Finished processing mini-batches for batch ${
          batchIndex + 1
        }. Fetched ${fetchedCount} items so far.`
      );

      // Delay between larger batches
      if (batchIndex < batches.length - 1) {
        await delay(DELAY_BETWEEN_BATCHES);
      }
    }

    console.log(
      `Finished processing nutrition data. Total items fetched in this run: ${fetchedCount}`
    );
  } catch (error) {
    console.error("Error processing nutrition data:", error);
  }
}

// Export only the necessary function for the API route
export { scrapeAllLocations };
