const fs = require("fs");

/**
 * Boolean function to test if all recipe IDs from buckets data are found in both nutrition cache files
 * @returns {boolean} true if all recipe IDs are present in both cache files, false otherwise
 */
function areAllRecipeIdsInBothCaches() {
  try {
    // Read all three files
    const bucketsData = JSON.parse(
      fs.readFileSync("Buckets Data Jun 28 2025.json", "utf8")
    );
    const newNutritionCache = JSON.parse(
      fs.readFileSync("Nutrition Cache.json", "utf8")
    );
    const oldNutritionCache = JSON.parse(
      fs.readFileSync("nutrition_cache.json", "utf8")
    );

    // Extract all recipe IDs from buckets data
    const recipeIds = new Set();

    for (const locationId in bucketsData.locations) {
      const location = bucketsData.locations[locationId];
      for (const mealPeriod in location.mealPeriods) {
        for (const station in location.mealPeriods[mealPeriod].stations) {
          const itemIDs =
            location.mealPeriods[mealPeriod].stations[station].itemIDs;
          itemIDs.forEach((itemId) => {
            if (bucketsData.items[itemId]) {
              recipeIds.add(bucketsData.items[itemId].recipeId.toString());
            }
          });
        }
      }
    }

    // Check if all recipe IDs are present in both caches
    for (const recipeId of recipeIds) {
      if (
        !(recipeId in newNutritionCache) ||
        !(recipeId in oldNutritionCache)
      ) {
        return false;
      }
    }

    return true;
  } catch (error) {
    console.error(
      "Error checking nutrition cache completeness:",
      error.message
    );
    return false;
  }
}

// Export for use in other modules
module.exports = { areAllRecipeIdsInBothCaches };

// Run the test when script is executed directly
if (require.main === module) {
  const result = areAllRecipeIdsInBothCaches();
  console.log(`All recipe IDs present in both caches: ${result}`);
  process.exit(result ? 0 : 1);
}
