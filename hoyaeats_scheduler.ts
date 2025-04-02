import axios from "axios";
import * as cheerio from "cheerio";
import * as fs from "fs";
import { CronJob } from "cron";

interface FoodItem {
  name: string;
  recipeId: string;
  vegetarian: boolean;
  vegan: boolean;
  glutenFree: boolean;
  nutrition: Record<string, string>;
  location: string;
  timeFetched: string;
  mealTime: string; // Time of day the item is available (breakfast, lunch, dinner, etc.)
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

// Output file
const MENU_FILE = "all_locations_menu.json";

// Rate limiting settings
const BATCH_SIZE = 10; // Process 10 items at a time
const DELAY_BETWEEN_ITEMS = 500; // 500ms between items
const DELAY_BETWEEN_BATCHES = 5000; // 5 seconds between batches
const DELAY_BETWEEN_LOCATIONS = 1000; // 1 second between location fetches

// Helper function to delay execution
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchLocationPage(location: string): Promise<FoodItem[]> {
  const url = `${BASE_URL}/locations/${location}`;
  const response = await axios.get(url);
  const $ = cheerio.load(response.data as string);

  const foodItems: FoodItem[] = [];
  const timeFetched = new Date().toISOString();

  // Simplify our approach - directly find menu sections with headings
  const menuSections: Record<string, string> = {};

  // Find menu sections with headings (h2, h3, etc.)
  $(".menu-section-title, h2.f-hbold, h3.f-hbold").each((index, el) => {
    const heading = $(el).text().trim();
    if (heading && !heading.includes("Menu") && !heading.includes("Options")) {
      const sectionId = `section-${index}`;
      menuSections[sectionId] = heading;
      console.log(`Found menu section: ${heading}`);
    }
  });

  // If no menu sections found, try to get meal periods from the page
  if (Object.keys(menuSections).length === 0) {
    $(".c-tabs-nav__link-inner").each((index, el) => {
      const mealPeriod = $(el).text().trim();
      if (mealPeriod) {
        menuSections[`period-${index}`] = mealPeriod;
        console.log(`Found meal period: ${mealPeriod}`);
      }
    });
  }

  // Default meal time if we can't determine
  const defaultMealTime = location.includes("breakfast")
    ? "Breakfast"
    : location.includes("lunch")
    ? "Lunch"
    : location.includes("dinner")
    ? "Dinner"
    : "All Day";

  // If still no meal times, create a default
  if (Object.keys(menuSections).length === 0) {
    menuSections["default"] = defaultMealTime;
    console.log(`Using default meal time: ${defaultMealTime}`);
  }

  // Get all food items on the page
  $("a.show-nutrition").each((_, el) => {
    const element = $(el);
    const name = element.text().trim();
    const recipeId = element.attr("data-recipe") || "";
    const classList = element.attr("class") || "";

    // Try to determine which meal time section this belongs to
    // For simplicity, we'll use the first meal time or the default
    const mealTime = Object.values(menuSections)[0] || defaultMealTime;

    const vegetarian = classList.includes("prop-vegetarian");
    const vegan = classList.includes("prop-vegan");
    const glutenFree = classList.includes("prop-made_without_gluten");

    foodItems.push({
      name,
      recipeId,
      vegetarian,
      vegan,
      glutenFree,
      nutrition: {},
      location,
      timeFetched,
      mealTime,
    });
  });

  console.log(`Total items found for ${location}: ${foodItems.length}`);
  return foodItems;
}

async function fetchNutrition(
  recipeId: string,
  retryCount = 0
): Promise<Record<string, string>> {
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

async function processBatch(items: FoodItem[]): Promise<FoodItem[]> {
  const updatedItems: FoodItem[] = [];

  // Process one at a time with delay to avoid rate limiting
  for (const item of items) {
    if (!item.recipeId) {
      updatedItems.push(item);
      continue;
    }

    try {
      console.log(`Fetching nutrition for ${item.name} (${item.recipeId})`);
      await delay(DELAY_BETWEEN_ITEMS);
      const nutrition = await fetchNutrition(item.recipeId);
      console.log(`Successfully fetched nutrition for ${item.name}`);

      updatedItems.push({
        ...item,
        nutrition,
        timeFetched: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`Failed to fetch nutrition for ${item.name}:`, err);
      updatedItems.push(item);
    }
  }

  return updatedItems;
}

async function scrapeAllLocations() {
  console.log(`Starting HoyaEats scrape at ${new Date().toISOString()}`);
  const allItems: FoodItem[] = [];

  for (const location of LOCATIONS) {
    console.log(`Fetching food items from ${location}...`);
    const items = await fetchLocationPage(location);
    console.log(`Found ${items.length} items at ${location}`);

    // Process items in batches
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      console.log(
        `Processing batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(
          items.length / BATCH_SIZE
        )} for ${location}`
      );

      const processedBatch = await processBatch(batch);
      allItems.push(...processedBatch);

      // Save progress after each batch
      const timestamp = new Date().toISOString().split("T")[0];
      fs.writeFileSync(MENU_FILE, JSON.stringify(allItems, null, 2));
      console.log(`Saved progress to ${MENU_FILE}`);

      // Wait between batches to avoid rate limiting
      if (i + BATCH_SIZE < items.length) {
        console.log(
          `Waiting ${DELAY_BETWEEN_BATCHES / 1000} seconds before next batch...`
        );
        await delay(DELAY_BETWEEN_BATCHES);
      }
    }

    // Wait between locations
    if (location !== LOCATIONS[LOCATIONS.length - 1]) {
      await delay(DELAY_BETWEEN_LOCATIONS);
    }
  }

  // Final save
  fs.writeFileSync(MENU_FILE, JSON.stringify(allItems, null, 2));

  // Verify the data quality
  const itemsWithNutrition = allItems.filter(
    (item) => item.nutrition && Object.keys(item.nutrition).length > 0
  );

  console.log(`Scrape complete at ${new Date().toISOString()}`);
  console.log(`Total items: ${allItems.length}`);
  console.log(`Items with nutrition data: ${itemsWithNutrition.length}`);

  return allItems;
}

// Setup the cron job (runs at 2AM Eastern Time)
// Note: '0 2 * * *' means at 2:00 AM every day
// We need to adjust for Eastern Time (EST/EDT)
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

// Function to handle manual scrape
async function runScrape() {
  console.log("Running manual HoyaEats menu scrape");
  await scrapeAllLocations();
}

// Check if this is being run directly
if (require.main === module) {
  // Start the cron job
  job.start();
  console.log("HoyaEats scheduler started");
  console.log("Next scheduled run:", job.nextDate().toString());

  // Run immediately on first start if --scrape flag is provided
  if (process.argv.includes("--scrape")) {
    runScrape();
  }
}

// Export functions for use in other scripts
export { scrapeAllLocations, runScrape };
