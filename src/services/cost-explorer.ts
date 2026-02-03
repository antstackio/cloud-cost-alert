import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostForecastCommand,
  Granularity,
} from "@aws-sdk/client-cost-explorer";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { CostData, ServiceCost, DateRange, CostQueryOptions } from "../types";

const client = new CostExplorerClient({ region: process.env.REGION });
const stsClient = new STSClient({ region: process.env.REGION });

// Cache for account ID to avoid repeated API calls
let cachedAccountId: string | null = null;

export async function getAccountId(): Promise<string> {
  if (cachedAccountId) {
    return cachedAccountId;
  }

  const command = new GetCallerIdentityCommand({});
  const response = await stsClient.send(command);
  const accountId = response.Account || "Unknown";
  cachedAccountId = accountId;
  return accountId;
}

/**
 * Parse CHILD_ACCOUNTS environment variable into account map.
 * Format: "accountId,accountId,..." (comma-separated account IDs)
 * Returns null if env var is empty or not set.
 */
export function getConfiguredAccounts(): Map<
  string,
  { id: string; name: string }
> | null {
  const raw = process.env.CHILD_ACCOUNTS || "";
  if (!raw.trim()) return null;

  const accounts = new Map<string, { id: string; name: string }>();

  for (const entry of raw.split(",")) {
    const id = entry.trim();
    if (id) {
      accounts.set(id, { id, name: id });
    }
  }

  return accounts.size > 0 ? accounts : null;
}

/**
 * Get account name from configured accounts or fallback to account ID
 */
export function getAccountName(
  accountId: string,
  configuredAccounts?: Map<string, { id: string; name: string }> | null,
): string {
  if (configuredAccounts) {
    const account = configuredAccounts.get(accountId);
    if (account) {
      return account.name;
    }
  }

  return accountId;
}

/**
 * Check if organization mode should be enabled.
 * Returns true if CHILD_ACCOUNTS env var has configured accounts.
 */
export function shouldUseOrganizationMode(): boolean {
  const accounts = getConfiguredAccounts();
  return accounts !== null && accounts.size > 0;
}

const TOP_SERVICES_COUNT = Number(process.env.TOP_SERVICES_COUNT) || 20;

/**
 * Helper function to get service-to-region mapping
 * Returns a map where key is service name and value is the primary region (by cost)
 */
async function getServiceRegionMap(
  dateRange: DateRange,
): Promise<Map<string, string>> {
  const command = new GetCostAndUsageCommand({
    TimePeriod: {
      Start: dateRange.start,
      End: dateRange.end,
    },
    Granularity: Granularity.MONTHLY,
    Metrics: ["UnblendedCost"],
    GroupBy: [
      { Type: "DIMENSION", Key: "SERVICE" },
      { Type: "DIMENSION", Key: "REGION" },
    ],
  });

  const response = await client.send(command);
  const serviceRegionCosts = new Map<
    string,
    { region: string; cost: number }
  >();

  if (response.ResultsByTime) {
    for (const result of response.ResultsByTime) {
      if (result.Groups) {
        for (const group of result.Groups) {
          const serviceName = group.Keys?.[0] || "Unknown";
          const region = group.Keys?.[1] || "global";
          const cost = parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");

          // Keep track of the region with highest cost for each service
          const existing = serviceRegionCosts.get(serviceName);
          if (!existing || cost > existing.cost) {
            serviceRegionCosts.set(serviceName, { region, cost });
          }
        }
      }
    }
  }

  // Convert to simple service -> region map
  const result = new Map<string, string>();
  for (const [service, data] of serviceRegionCosts) {
    result.set(service, data.region);
  }
  return result;
}

export async function getCosts(
  dateRange: DateRange,
  options: CostQueryOptions = {},
): Promise<CostData> {
  const { includeForecasts = false, groupByAccount = false } = options;

  // Fetch configured accounts for name resolution (if grouping by account)
  const orgAccounts = groupByAccount ? getConfiguredAccounts() : null;
  const uniqueAccounts = new Set<string>();

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

  if (groupByAccount) {
    // Organization mode: Need TWO API calls to get all dimensions
    // Call 1: LINKED_ACCOUNT + SERVICE (to get account and service info)
    // Call 2: SERVICE + REGION (to get region info per service)

    // First, get the service-to-region mapping
    const serviceRegionMap = await getServiceRegionMap(dateRange);

    // Then get costs by account and service
    const command = new GetCostAndUsageCommand({
      TimePeriod: {
        Start: dateRange.start,
        End: dateRange.end,
      },
      Granularity: Granularity.MONTHLY,
      Metrics: ["UnblendedCost"],
      GroupBy: [
        { Type: "DIMENSION", Key: "LINKED_ACCOUNT" },
        { Type: "DIMENSION", Key: "SERVICE" },
      ],
    });

    const response = await client.send(command);

    if (response.ResultsByTime && response.ResultsByTime.length > 0) {
      for (const result of response.ResultsByTime) {
        if (result.Groups) {
          for (const group of result.Groups) {
            // Keys: [LINKED_ACCOUNT, SERVICE]
            const accountId = group.Keys?.[0] || undefined;
            const serviceName = group.Keys?.[1] || "Unknown";
            const cost = parseFloat(
              group.Metrics?.UnblendedCost?.Amount || "0",
            );

            if (accountId) uniqueAccounts.add(accountId);

            if (cost > 0) {
              // Look up the primary region for this service
              const region = serviceRegionMap.get(serviceName) || "global";

              const serviceCost: ServiceCost = {
                service: serviceName,
                cost: cost,
                region: region,
                accountId: accountId,
                accountName: getAccountName(accountId!, orgAccounts),
              };

              // Calculate monthly forecast based on daily average if requested
              if (includeForecasts) {
                const dailyAverage = cost / daysInPeriod;
                serviceCost.forecast = dailyAverage * 30;
              }

              serviceCosts.push(serviceCost);
              totalCost += cost;
            }
          }
        }
      }
    }
  } else {
    // Single account mode: Single API call with SERVICE + REGION
    const command = new GetCostAndUsageCommand({
      TimePeriod: {
        Start: dateRange.start,
        End: dateRange.end,
      },
      Granularity: Granularity.MONTHLY,
      Metrics: ["UnblendedCost"],
      GroupBy: [
        { Type: "DIMENSION", Key: "SERVICE" },
        { Type: "DIMENSION", Key: "REGION" },
      ],
    });

    const response = await client.send(command);

    if (response.ResultsByTime && response.ResultsByTime.length > 0) {
      for (const result of response.ResultsByTime) {
        if (result.Groups) {
          for (const group of result.Groups) {
            // Keys: [SERVICE, REGION]
            const serviceName = group.Keys?.[0] || "Unknown";
            const region = group.Keys?.[1] || "global";
            const cost = parseFloat(
              group.Metrics?.UnblendedCost?.Amount || "0",
            );

            if (cost > 0) {
              const serviceCost: ServiceCost = {
                service: serviceName,
                cost: cost,
                region: region,
              };

              // Calculate monthly forecast based on daily average if requested
              if (includeForecasts) {
                const dailyAverage = cost / daysInPeriod;
                serviceCost.forecast = dailyAverage * 30;
              }

              serviceCosts.push(serviceCost);
              totalCost += cost;
            }
          }
        }
      }
    }
  }

  // Sort by cost descending and get top N
  serviceCosts.sort((a, b) => b.cost - a.cost);
  const topServices = serviceCosts.slice(0, TOP_SERVICES_COUNT);

  return {
    totalCost,
    topServices,
    startDate: dateRange.start,
    endDate: dateRange.end,
    isOrganizationMode: groupByAccount,
    accountCount: uniqueAccounts.size,
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
