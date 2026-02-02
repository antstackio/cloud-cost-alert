import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostForecastCommand,
  Granularity,
} from "@aws-sdk/client-cost-explorer";
import { CostData, ServiceCost, DateRange } from "../types";

const client = new CostExplorerClient({ region: process.env.REGION });
const TOP_SERVICES_COUNT = Number(process.env.TOP_SERVICES_COUNT);

export async function getCosts(
  dateRange: DateRange,
  includeForecasts: boolean = false,
): Promise<CostData> {
  // Query with both SERVICE and REGION dimensions to get costs across all regions
  const command = new GetCostAndUsageCommand({
    TimePeriod: {
      Start: dateRange.start,
      End: dateRange.end,
    },
    Granularity: Granularity.MONTHLY,
    Metrics: ["UnblendedCost"],
    GroupBy: [
      {
        Type: "DIMENSION",
        Key: "SERVICE",
      },
      {
        Type: "DIMENSION",
        Key: "REGION",
      },
    ],
  });

  const response = await client.send(command);

  const serviceCosts: ServiceCost[] = [];
  let totalCost = 0;

  // Calculate number of days in the period for forecast calculation
  const startDate = new Date(dateRange.start);
  const endDate = new Date(dateRange.end);
  const daysInPeriod = Math.max(
    1,
    Math.ceil(
      (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
    ),
  );

  if (response.ResultsByTime && response.ResultsByTime.length > 0) {
    for (const result of response.ResultsByTime) {
      if (result.Groups) {
        for (const group of result.Groups) {
          // Keys[0] = SERVICE, Keys[1] = REGION
          const serviceName = group.Keys?.[0] || "Unknown";
          const region = group.Keys?.[1] || "global";
          const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");

          if (cost > 0) {
            const serviceCost: ServiceCost = {
              service: serviceName,
              cost: cost,
              region: region,
            };

            // Calculate monthly forecast based on daily average if requested
            if (includeForecasts) {
              const dailyAverage = cost / daysInPeriod;
              serviceCost.forecast = dailyAverage * 30; // Project to 30 days
            }

            serviceCosts.push(serviceCost);
            totalCost += cost;
          }
        }
      }
    }
  }

  // Sort by cost descending and get top 10
  serviceCosts.sort((a, b) => b.cost - a.cost);
  const topServices = serviceCosts.slice(0, TOP_SERVICES_COUNT);

  return {
    totalCost,
    topServices,
    startDate: dateRange.start,
    endDate: dateRange.end,
  };
}

export async function getCostForecast(dateRange: DateRange): Promise<number> {
  // Forecast requires start date to be in the future or today
  const today = new Date().toISOString().split("T")[0];
  const startDate = dateRange.start < today ? today : dateRange.start;

  // If we're at the end of the month, return 0 as no forecast is needed
  if (startDate >= dateRange.end) {
    return 0;
  }

  const command = new GetCostForecastCommand({
    TimePeriod: {
      Start: startDate,
      End: dateRange.end,
    },
    Metric: "UNBLENDED_COST",
    Granularity: Granularity.MONTHLY,
  });

  try {
    const response = await client.send(command);
    return parseFloat(response.Total?.Amount || "0");
  } catch (error) {
    // If forecast fails (e.g., not enough data), return 0
    console.warn("Failed to get cost forecast:", error);
    return 0;
  }
}

export async function getTotalCostForPeriod(
  dateRange: DateRange,
): Promise<number> {
  const command = new GetCostAndUsageCommand({
    TimePeriod: {
      Start: dateRange.start,
      End: dateRange.end,
    },
    Granularity: Granularity.MONTHLY,
    Metrics: ["UnblendedCost"],
  });

  const response = await client.send(command);

  let totalCost = 0;
  if (response.ResultsByTime) {
    for (const result of response.ResultsByTime) {
      totalCost += parseFloat(result.Total?.UnblendedCost?.Amount || "0");
    }
  }

  return totalCost;
}
