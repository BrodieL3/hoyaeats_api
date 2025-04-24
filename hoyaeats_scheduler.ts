import axios from "axios";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
import { CronJob } from "cron";
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

// Output files
const MENUS_DIR = "menus";
const CACHE_FILE = "nutrition_cache.json";

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

// Optimized rate limiting settings
const CONCURRENT_REQUESTS = 5; // Process 5 requests in parallel
const BATCH_SIZE = 25; // Process 25 items at a time
const DELAY_BETWEEN_ITEMS = 200; // 200ms between items
const DELAY_BETWEEN_BATCHES = 1000; // 1 second between batches
const DELAY_BETWEEN_LOCATIONS = 500; // 0.5 second between location fetches
const DELAY_BETWEEN_DAYS = 1000; // 1 second between days

// Cache for nutrition data
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

// Load nutrition cache from file if it exists
function loadNutritionCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cacheData = fs.readFileSync(CACHE_FILE, "utf8");
      nutritionCache = JSON.parse(cacheData);
      console.log(
        `Loaded ${Object.keys(nutritionCache).length} cached nutrition items`
      );
    } else {
      nutritionCache = {};
    }
  } catch (err) {
    console.error("Error loading nutrition cache:", err);
    nutritionCache = {};
  }
}

// Save nutrition cache to file
function saveNutritionCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(nutritionCache, null, 2));
    console.log(
      `Saved ${Object.keys(nutritionCache).length} nutrition items to cache`
    );

    // Upload nutrition cache to Supabase
    uploadToSupabase(CACHE_FILE, "nutrition_cache.json").catch((err) => {
      console.error("Error uploading nutrition cache to Supabase:", err);
    });
  } catch (err) {
    console.error("Error saving nutrition cache:", err);
  }
}

// Upload file to Supabase storage
async function uploadToSupabase(filePath: string, fileName: string) {
  try {
    const fileData = fs.readFileSync(filePath);

    const { data, error } = await supabase.storage
      .from("menus")
      .upload(fileName, fileData, {
        contentType: "application/json",
        upsert: true,
      });

    if (error) {
      throw error;
    }

    console.log(`Successfully uploaded ${fileName} to Supabase storage`);
    return data;
  } catch (error) {
    console.error(`Error uploading ${fileName} to Supabase:`, error);
    throw error;
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

async function fetchNutrition(
  recipeId: number, // Changed to number type
  retryCount = 0
): Promise<Record<string, string>> {
  const recipeIdStr = recipeId.toString();

  // Check cache first
  if (
    nutritionCache[recipeIdStr] &&
    Object.keys(nutritionCache[recipeIdStr]).length > 0
  ) {
    return nutritionCache[recipeIdStr];
  }

  try {
    const url = `${RECIPE_ENDPOINT}${recipeId}`;
    const response = await axios.get<NutritionResponse>(url);
    const data = response.data;

    if (!data.success || !data.html) {
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

      // Skip rows we've already processed
      if (
        rowText.includes("Amount Per Serving") ||
        rowText.includes("Calories") ||
        rowText.includes("Total Fat") ||
        rowText.includes("Total Carbohydrate") ||
        rowText.includes("Protein")
      ) {
        return;
      }

      // Process other nutrients
      const nutrientMatches = rowText.match(
        /([A-Za-z\s]+)([\d\.]+\s*[a-z]+)(\d+%)?/i
      );
      if (nutrientMatches && nutrientMatches[1] && nutrientMatches[2]) {
        const name = nutrientMatches[1].trim();
        const value = nutrientMatches[2].trim();

        if (name && value && !name.includes("blank-cell")) {
          nutrition[name] = value;
        }
      }
    });

    // Verify we have the essential nutrients
    const essentialNutrients = ["Fat", "Carbohydrate", "Protein"];
    const missingNutrients = essentialNutrients.filter(
      (nutrient) => !nutrition[nutrient]
    );

    if (missingNutrients.length > 0) {
      console.warn(
        `Missing essential nutrients for recipe ${recipeId}: ${missingNutrients.join(
          ", "
        )}`
      );

      // Try alternative extraction for missing nutrients
      const htmlText = data.html;

      for (const nutrient of missingNutrients) {
        if (nutrient === "Fat" && htmlText.includes("Total Fat")) {
          const fatMatch = htmlText.match(/<b>Total Fat<\/b>\s+([\d\.]+\s*g)/);
          if (fatMatch && fatMatch[1]) nutrition["Fat"] = fatMatch[1].trim();
        }

        if (
          nutrient === "Carbohydrate" &&
          htmlText.includes("Total Carbohydrate")
        ) {
          const carbMatch = htmlText.match(
            /<b>Total Carbohydrate<\/b>\s+([\d\.]+\s*g)/
          );
          if (carbMatch && carbMatch[1])
            nutrition["Carbohydrate"] = carbMatch[1].trim();
        }

        if (nutrient === "Protein" && htmlText.includes("Protein")) {
          const proteinMatch = htmlText.match(
            /<b>Protein<\/b>\s+([\d\.]+\s*g)/
          );
          if (proteinMatch && proteinMatch[1])
            nutrition["Protein"] = proteinMatch[1].trim();
        }
      }
    }

    // Save to cache
    nutritionCache[recipeIdStr] = nutrition;
    return nutrition;
  } catch (err: any) {
    if (err.response?.status === 429 && retryCount < 3) {
      const retryAfter = parseInt(
        err.response.headers["retry-after"] || "5",
        10
      );
      const waitTime = (retryAfter + Math.random() * 2) * 1000;
      console.log(
        `Rate limited. Waiting ${waitTime / 1000} seconds before retry ${
          retryCount + 1
        } for recipe ${recipeId}`
      );
      await delay(waitTime);
      return fetchNutrition(recipeId, retryCount + 1);
    }
    console.error(`Error fetching nutrition for recipe ${recipeId}:`, err);
    return {};
  }
}

// Create a batch processor for nutrition data
async function processNutritionData(
  menuData: MenuData,
  itemsMap: Record<string, any>,
  concurrency = CONCURRENT_REQUESTS
): Promise<void> {
  // Collect all recipe IDs that need nutrition data
  const recipesToFetch: { recipeId: number; reference: FoodItem }[] = [];

  // Traverse the menu structure to find all food items
  Object.values(menuData.locations).forEach((location) => {
    Object.values(location.days).forEach((day) => {
      Object.values(day.mealPeriods).forEach((mealPeriod) => {
        Object.values(mealPeriod.stations).forEach((station) => {
          station.items.forEach((item) => {
            if (item.recipeId && Object.keys(item.nutrition).length === 0) {
              recipesToFetch.push({ recipeId: item.recipeId, reference: item });
            }
          });
        });
      });
    });
  });

  // Also check items in the normalized structure
  Object.values(itemsMap).forEach((item) => {
    if (
      item.recipeId &&
      !recipesToFetch.some((r) => r.recipeId === item.recipeId)
    ) {
      recipesToFetch.push({ recipeId: item.recipeId, reference: item });
    }
  });

  console.log(
    `Need to fetch nutrition data for ${recipesToFetch.length} items`
  );

  // Process in batches with controlled concurrency
  const batches: (typeof recipesToFetch)[] = [];
  for (let i = 0; i < recipesToFetch.length; i += BATCH_SIZE) {
    batches.push(recipesToFetch.slice(i, i + BATCH_SIZE));
  }

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    console.log(
      `Processing nutrition batch ${batchIndex + 1} of ${batches.length}`
    );

    // Process each mini-batch concurrently
    const miniBatches: (typeof recipesToFetch)[] = [];
    for (let i = 0; i < batch.length; i += concurrency) {
      miniBatches.push(batch.slice(i, i + concurrency));
    }

    for (const miniBatch of miniBatches) {
      await Promise.all(
        miniBatch.map(async ({ recipeId, reference }) => {
          try {
            const nutrition = await fetchNutrition(recipeId);
            reference.nutrition = nutrition;
          } catch (err) {
            console.error(`Error fetching nutrition for ${recipeId}:`, err);
          }
        })
      );

      // Small delay between mini-batches
      await delay(DELAY_BETWEEN_ITEMS);
    }

    // Delay between larger batches
    if (batchIndex < batches.length - 1) {
      await delay(DELAY_BETWEEN_BATCHES);
    }
  }

  console.log("Finished fetching all nutrition data");
}

// Check which dates need to be generated
function getDatesToProcess(allDates: string[]): string[] {
  try {
    if (!fs.existsSync(MENUS_DIR)) {
      fs.mkdirSync(MENUS_DIR, { recursive: true });
      console.log(`Created ${MENUS_DIR} directory`);
      return allDates; // Generate all if directory doesn't exist
    }

    const existingFiles = fs.readdirSync(MENUS_DIR);
    const existingDates = existingFiles
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(".json", ""))
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)); // Ensure we have valid date format

    const datesToProcess = allDates.filter(
      (date) => !existingDates.includes(date)
    );

    console.log(`Found ${existingDates.length} existing date files`);
    console.log(`Need to generate ${datesToProcess.length} new date files`);

    return datesToProcess;
  } catch (err) {
    console.error("Error checking existing dates:", err);
    return allDates; // Process all dates if there's an error
  }
}

async function scrapeAllLocations() {
  console.log(`Starting HoyaEats scrape at ${new Date().toISOString()}`);

  // Ensure menus directory exists
  if (!fs.existsSync(MENUS_DIR)) {
    fs.mkdirSync(MENUS_DIR, { recursive: true });
    console.log(`Created ${MENUS_DIR} directory`);
  }

  // Load nutrition cache first
  loadNutritionCache();

  // Get all dates for the next week
  const allDates = getNextWeekDates();

  // Check which dates we need to process
  const datesToProcess = getDatesToProcess(allDates);

  if (datesToProcess.length === 0) {
    console.log("All date files already exist, nothing to do.");
    return true;
  }

  // Process data for each date that needs processing
  for (const date of datesToProcess) {
    console.log(`Processing menu for date: ${date}`);

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
      }

      // Wait between locations
      if (locationId !== LOCATIONS[LOCATIONS.length - 1]) {
        await delay(DELAY_BETWEEN_LOCATIONS);
      }
    }

    // Process nutrition data for all items
    await processNutritionData(menuData, itemsMap);

    // Create normalized structure for this date
    const normalizedMenuData: NormalizedMenuData = {
      locations: {},
      items: {},
      date,
      lastUpdated: new Date().toISOString(),
    };

    // Convert the structure to use references
    Object.entries(menuData.locations).forEach(([locationId, location]) => {
      normalizedMenuData.locations[locationId] = {
        name: location.name,
        mealPeriods: {},
      };

      // Get data for this date
      const dateData = location.days[date];
      if (!dateData) return;

      Object.entries(dateData.mealPeriods).forEach(([mealTime, mealData]) => {
        normalizedMenuData.locations[locationId].mealPeriods[mealTime] = {
          stations: {},
        };

        Object.entries(mealData.stations).forEach(
          ([stationName, stationData]) => {
            // Ensure stationData has itemIDs property
            if (stationData.itemIDs && stationData.itemIDs.length > 0) {
              normalizedMenuData.locations[locationId].mealPeriods[
                mealTime
              ].stations[stationName] = {
                itemIDs: stationData.itemIDs,
              };
            } else {
              // If itemIDs is missing, generate them from items (this shouldn't happen with our updated code)
              const itemIDs = stationData.items.map((item) =>
                generateSlug(item.name, item.recipeId.toString())
              );
              normalizedMenuData.locations[locationId].mealPeriods[
                mealTime
              ].stations[stationName] = {
                itemIDs: itemIDs,
              };
            }
          }
        );
      });
    });

    // Add items without nutrition field
    normalizedMenuData.items = itemsMap;

    // Save the results for this date
    const dateFilePath = path.join(MENUS_DIR, `${date}.json`);
    fs.writeFileSync(dateFilePath, JSON.stringify(normalizedMenuData, null, 2));
    console.log(`Saved menu data for ${date} to ${dateFilePath}`);

    // Upload to Supabase
    try {
      await uploadToSupabase(dateFilePath, `${date}.json`);
    } catch (error) {
      console.error(`Failed to upload ${date}.json to Supabase`, error);
    }
  }

  // Save the nutrition cache
  saveNutritionCache();

  console.log(`Scrape complete at ${new Date().toISOString()}`);
  console.log(`Processed ${datesToProcess.length} days of menu data`);

  return true;
}

// Setup the cron job (runs at 2AM Eastern Time and creates files for the upcoming day)
const job = new CronJob(
  "0 2 * * *", // Runs at 2:00 AM
  function () {
    console.log("Running scheduled HoyaEats menu scrape");
    scrapeAllLocations().catch((err) => {
      console.error("Error in scheduled scrape:", err);
    });
  },
  null, // onComplete
  false, // start immediately
  "America/New_York" // Eastern Time Zone
);

// Create a specific daily job to generate tomorrow's menu
const dailyJob = new CronJob(
  "0 3 * * *", // Runs at 3:00 AM
  async function () {
    try {
      console.log("Running daily menu scrape for tomorrow");

      // Get tomorrow's date
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split("T")[0];

      // Check if tomorrow's file already exists
      const tomorrowFilePath = path.join(MENUS_DIR, `${tomorrowStr}.json`);
      if (fs.existsSync(tomorrowFilePath)) {
        console.log(`File for ${tomorrowStr} already exists, skipping.`);
        return;
      }

      // Create menu data structure for tomorrow
      const menuData: MenuData = {
        locations: {},
        lastUpdated: new Date().toISOString(),
      };

      // Items map for normalized structure
      const itemsMap: Record<string, any> = {};

      // Load nutrition cache
      loadNutritionCache();

      // Process each location for tomorrow
      for (const locationId of LOCATIONS) {
        // Initialize location in menu data
        menuData.locations[locationId] = {
          name: locationId
            .replace(/-/g, " ")
            .replace(/\b\w/g, (l) => l.toUpperCase()),
          days: {},
        };

        // Fetch location data for tomorrow
        const locationData = await fetchLocationPage(locationId, tomorrowStr);

        // Add tomorrow's data to the menu structure
        if (Object.keys(locationData.mealPeriods).length > 0) {
          menuData.locations[locationId].days[tomorrowStr] = locationData;

          // Add each food item to the centralized items map
          Object.values(locationData.mealPeriods).forEach((mealPeriod) => {
            Object.values(mealPeriod.stations).forEach((station) => {
              station.items.forEach((item, index) => {
                const itemID = station.itemIDs[index];
                if (!itemsMap[itemID]) {
                  const { nutrition, ...itemWithoutNutrition } = item;
                  itemsMap[itemID] = itemWithoutNutrition;
                }
              });
            });
          });
        }

        await delay(DELAY_BETWEEN_LOCATIONS);
      }

      // Process nutrition data
      await processNutritionData(menuData, itemsMap);

      // Create normalized structure
      const normalizedMenuData: NormalizedMenuData = {
        locations: {},
        items: {},
        date: tomorrowStr,
        lastUpdated: new Date().toISOString(),
      };

      // Convert structure to use references
      Object.entries(menuData.locations).forEach(([locationId, location]) => {
        normalizedMenuData.locations[locationId] = {
          name: location.name,
          mealPeriods: {},
        };

        const dateData = location.days[tomorrowStr];
        if (!dateData) return;

        Object.entries(dateData.mealPeriods).forEach(([mealTime, mealData]) => {
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
              }
            }
          );
        });
      });

      // Add items without nutrition field
      normalizedMenuData.items = itemsMap;

      // Save results for tomorrow
      fs.writeFileSync(
        tomorrowFilePath,
        JSON.stringify(normalizedMenuData, null, 2)
      );
      console.log(`Saved menu data for ${tomorrowStr} to ${tomorrowFilePath}`);

      // Upload to Supabase
      await uploadToSupabase(tomorrowFilePath, `${tomorrowStr}.json`);

      // Save nutrition cache
      saveNutritionCache();

      console.log(`Daily scrape for ${tomorrowStr} complete`);
    } catch (err) {
      console.error("Error in daily scrape:", err);
    }
  },
  null,
  false,
  "America/New_York"
);

// Function to handle manual scrape
async function runScrape() {
  console.log("Running manual HoyaEats menu scrape");
  await scrapeAllLocations();
}

// Check if this is being run directly
if (require.main === module) {
  // Start the cron jobs
  job.start();
  dailyJob.start();
  console.log("HoyaEats scheduler started");
  console.log("Next scheduled full run:", job.nextDate().toString());
  console.log("Next scheduled daily run:", dailyJob.nextDate().toString());

  // Run immediately on first start if --scrape flag is provided
  if (process.argv.includes("--scrape")) {
    runScrape();
  }
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
  if (recipeId) {
    // Take the last 6 characters of the recipe ID to ensure uniqueness
    const idSuffix = recipeId.substring(Math.max(0, recipeId.length - 6));
    slug = `${slug}-${idSuffix}`;
  }

  return slug;
}

// Export functions for use in other scripts
export { scrapeAllLocations, runScrape, NormalizedMenuData };
