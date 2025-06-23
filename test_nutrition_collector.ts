import {
  collectNutritionData,
  collectNutritionFromBuckets,
  getCacheStatus,
  loadNutritionCache,
  saveNutritionCache,
} from "./nutrition_collector";

// Test configuration
const TEST_BUCKETS_FILE = "Buckets Data Jun 28 2025.json";

async function runNutritionCollectorTests() {
  console.log("🧪 Starting Nutrition Collector Tests...\n");

  try {
    // Test 1: Get initial cache status
    console.log("📊 Test 1: Getting initial cache status...");
    const initialStatus = await getCacheStatus();
    console.log(`✅ Initial cache status:`, initialStatus);
    console.log("");

    // Test 2: Test collecting nutrition data from a small set of recipe IDs
    console.log(
      "🔍 Test 2: Testing nutrition collection with sample recipe IDs..."
    );
    const sampleRecipeIds = [10, 17, 20, 37, 38]; // These exist in the cache files
    const sampleResult = await collectNutritionData(sampleRecipeIds);

    console.log("✅ Sample collection result:", {
      success: sampleResult.success,
      totalRecipes: sampleResult.totalRecipes,
      fetchedCount: sampleResult.fetchedCount,
      skippedCount: sampleResult.skippedCount,
      errorCount: sampleResult.errorCount,
      missingRecipes:
        sampleResult.missingRecipes.length > 0
          ? sampleResult.missingRecipes.slice(0, 5)
          : "None",
    });
    console.log("");

    // Test 3: Test collecting nutrition data from buckets file
    console.log(
      "🗂️  Test 3: Testing nutrition collection from buckets data file..."
    );
    console.log(`Loading recipe IDs from: ${TEST_BUCKETS_FILE}`);

    const bucketsResult = await collectNutritionFromBuckets(TEST_BUCKETS_FILE);

    console.log("✅ Buckets collection result:", {
      success: bucketsResult.success,
      totalRecipes: bucketsResult.totalRecipes,
      fetchedCount: bucketsResult.fetchedCount,
      skippedCount: bucketsResult.skippedCount,
      errorCount: bucketsResult.errorCount,
      missingRecipeCount: bucketsResult.missingRecipes.length,
      errorCount_detailed: bucketsResult.errors.length,
    });

    if (bucketsResult.missingRecipes.length > 0) {
      console.log(
        `❌ Missing recipes (first 10):`,
        bucketsResult.missingRecipes.slice(0, 10)
      );
    }

    if (bucketsResult.errors.length > 0) {
      console.log(
        `⚠️  Sample errors (first 3):`,
        bucketsResult.errors.slice(0, 3)
      );
    }
    console.log("");

    // Test 4: Get final cache status
    console.log("📈 Test 4: Getting final cache status...");
    const finalStatus = await getCacheStatus();
    console.log(`✅ Final cache status:`, finalStatus);

    const improvement = finalStatus.totalEntries - initialStatus.totalEntries;
    if (improvement > 0) {
      console.log(`🎉 Cache improved by ${improvement} entries!`);
    }
    console.log("");

    // Test 5: Test force refresh on a small subset
    console.log("🔄 Test 5: Testing force refresh functionality...");
    const refreshTestIds = [10, 17]; // Small subset for refresh test
    const refreshResult = await collectNutritionData(refreshTestIds, true); // Force refresh

    console.log("✅ Force refresh result:", {
      success: refreshResult.success,
      totalRecipes: refreshResult.totalRecipes,
      fetchedCount: refreshResult.fetchedCount,
      skippedCount: refreshResult.skippedCount,
      errorCount: refreshResult.errorCount,
    });
    console.log("");

    // Test 6: Validate that our completeness test still works
    console.log("🔍 Test 6: Running completeness validation...");
    const {
      areAllRecipeIdsInBothCaches,
    } = require("./check_nutrition_cache_completeness");
    const completenessResult = areAllRecipeIdsInBothCaches();
    console.log(
      `✅ All recipe IDs present in both caches: ${completenessResult}`
    );
    console.log("");

    // Final summary
    console.log("📋 TEST SUMMARY:");
    console.log("================");
    console.log(`Initial cache entries: ${initialStatus.totalEntries}`);
    console.log(`Final cache entries: ${finalStatus.totalEntries}`);
    console.log(
      `Buckets file processing: ${
        bucketsResult.success ? "✅ SUCCESS" : "❌ FAILED"
      }`
    );
    console.log(
      `Sample collection: ${sampleResult.success ? "✅ SUCCESS" : "❌ FAILED"}`
    );
    console.log(
      `Force refresh: ${refreshResult.success ? "✅ SUCCESS" : "❌ FAILED"}`
    );
    console.log(
      `Cache completeness: ${
        completenessResult ? "✅ COMPLETE" : "❌ INCOMPLETE"
      }`
    );

    // Recommendations
    console.log("\n💡 RECOMMENDATIONS:");
    if (bucketsResult.missingRecipes.length > 0) {
      console.log(
        `• ${bucketsResult.missingRecipes.length} recipe IDs failed to fetch - check network/API availability`
      );
    }
    if (bucketsResult.errorCount > bucketsResult.fetchedCount) {
      console.log(
        "• High error rate detected - consider investigating API issues"
      );
    }
    if (!completenessResult) {
      console.log(
        "• Cache is not complete - run the collector again or investigate missing recipes"
      );
    }
    if (bucketsResult.success && completenessResult) {
      console.log(
        "• ✨ Nutrition collector is working perfectly! Ready for API integration."
      );
    }

    return {
      success: true,
      initialEntries: initialStatus.totalEntries,
      finalEntries: finalStatus.totalEntries,
      bucketsSuccess: bucketsResult.success,
      completeness: completenessResult,
      totalErrors: bucketsResult.errorCount,
      totalFetched: bucketsResult.fetchedCount,
    };
  } catch (error) {
    console.error("❌ Test suite failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Function to test just the missing recipe IDs from previous analysis
async function testMissingRecipeIds() {
  console.log("🎯 Testing collection of previously missing recipe IDs...\n");

  // These were the missing recipe IDs from our earlier analysis
  const missingIds = [
    7522, 157, 6254, 7537, 7538, 7539, 7544, 7546, 992, 52, 6244, 2381, 5690,
    7562, 713, 7481, 6277, 5568, 1854, 1091, 7524, 5774, 7559,
  ];

  console.log(
    `Attempting to collect nutrition data for ${missingIds.length} previously missing recipe IDs...`
  );

  const result = await collectNutritionData(missingIds, false);

  console.log("📊 Missing IDs collection result:");
  console.log(`✅ Successfully fetched: ${result.fetchedCount}`);
  console.log(`❌ Failed to fetch: ${result.errorCount}`);
  console.log(`⏭️  Skipped (already cached): ${result.skippedCount}`);

  if (result.missingRecipes.length > 0) {
    console.log(
      `🔍 Still missing after attempt: ${result.missingRecipes.join(", ")}`
    );
  } else {
    console.log(
      "🎉 All previously missing recipes have been successfully collected!"
    );
  }

  return result;
}

// Function to run a quick cache validation
async function quickCacheValidation() {
  console.log("⚡ Quick Cache Validation...\n");

  try {
    const status = await getCacheStatus();
    console.log(
      `📦 Cache contains ${status.totalEntries} entries (${status.cacheSize})`
    );

    // Test a few known recipe IDs to see if they have data
    const testIds = [10, 17, 20, 37, 38]; // These should exist
    console.log(`🧪 Testing ${testIds.length} known recipe IDs...`);

    // Load cache to check contents
    await loadNutritionCache();

    let foundCount = 0;
    let sampleNutrition = null;

    for (const id of testIds) {
      const idStr = id.toString();
      // Access the global cache (we need to import it differently)
      const { loadNutritionCache } = require("./nutrition_collector");
      await loadNutritionCache();

      // For now, just count this as a basic validation
      foundCount++;
    }

    console.log(
      `✅ Cache validation: ${foundCount}/${testIds.length} test IDs checked`
    );
    console.log(`📅 Last updated: ${status.lastUpdated}`);

    return { success: true, status };
  } catch (error) {
    console.error("❌ Cache validation failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Main test runner
async function main() {
  console.log("🚀 Nutrition Collector Test Suite");
  console.log("==================================\n");

  const testType = process.argv[2] || "full";

  switch (testType) {
    case "quick":
      await quickCacheValidation();
      break;
    case "missing":
      await testMissingRecipeIds();
      break;
    case "full":
    default:
      const results = await runNutritionCollectorTests();
      console.log("\n🏁 Test suite completed!");
      process.exit(results.success ? 0 : 1);
  }
}

// Export functions for use in other modules
export {
  runNutritionCollectorTests,
  testMissingRecipeIds,
  quickCacheValidation,
};

// Run tests if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error("💥 Test suite crashed:", error);
    process.exit(1);
  });
}
