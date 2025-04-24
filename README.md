# HoyaEats Menu Scraper

This script fetches and updates menu data from HoyaEats dining locations, including nutritional information and meal time availability.

## Setup

1. Install dependencies:

```bash
npm install axios cheerio cron @types/cron
```

2. Compile TypeScript:

```bash
tsc hoyaeats_scheduler.ts
```

Alternatively, you can run directly with ts-node:

```bash
npx ts-node hoyaeats_scheduler.ts --scrape
```

## Usage

### Run the scheduler
To schedule to run at 2:00am EST

```bash
npx ts-node hoyaeats_scheduler.ts 
```

### Run a one-time scrape

To run just once without scheduling:

```bash
npx ts-node hoyaeats_scheduler.ts --scrape
```

## Output

The script creates/updates `all_locations_menu.json` with menu data from all locations, including:

- Food item name
- Recipe ID
- Dietary information (vegetarian, vegan, gluten-free)
- Full nutrition information (calories, fat, carbs, protein, etc.)
- Location
- Time fetched
- **Meal time availability** (breakfast, lunch, dinner, etc.)

### Meal Time Detection

The script automatically detects when food items are available by:

1. Looking for menu section headings
2. Extracting meal period information from navigation tabs
3. Falling back to location-based defaults if needed

This allows you to filter items by meal time (breakfast, lunch, dinner) when using the data.

## Rate Limiting

The script implements rate limiting to avoid being blocked by the server:

- 500ms delay between items
- 5 seconds delay between batches of 10 items
- 1 second delay between locations
- Automatic retries with exponential backoff on 429 errors

## System Requirements

- Node.js 14+
- npm or yarn

## Troubleshooting

If you encounter rate limiting issues even with the built-in delays, you can adjust the delay constants at the top of the script:

```typescript
const DELAY_BETWEEN_ITEMS = 500; // increase to 1000 if needed
const DELAY_BETWEEN_BATCHES = 5000; // increase to 10000 if needed
```

## Data Schema

Sample food item with all data:

```json
{
  "name": "Fried Egg",
  "recipeId": "339",
  "vegetarian": true,
  "vegan": false,
  "glutenFree": true,
  "nutrition": {
    "Serving Size": "1 each",
    "Calories": "90",
    "Fat": "7 g",
    "Carbohydrate": "0 g",
    "Protein": "6 g",
    "Saturated Fat": "2 g"
  },
  "location": "fresh-food-company",
  "timeFetched": "2023-04-02T10:15:22.390Z",
  "mealTime": "Breakfast (7am-11am)"
}
```
