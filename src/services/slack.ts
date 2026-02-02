import {
  WeeklyReportData,
  MonthlyReportData,
  SlackMessage,
  SlackBlock,
  ServiceCost,
  TableRow,
  RichTextCell,
  UnusedResource,
} from "../types";
import { formatCurrency, formatPercentDisplay } from "../utils/formatter";
import { formatDateDisplay } from "../utils/date-utils";

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

// Helper to create a table cell with text
function createCell(text: string, bold: boolean = false): RichTextCell {
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          {
            type: "text",
            text: text,
            style: bold ? { bold: true } : undefined,
          },
        ],
      },
    ],
  };
}

// Helper to format region name for display
function formatRegion(region: string): string {
  if (!region || region === "global") return "Global";
  return region;
}

// Build weekly services table using Slack's native table block
function buildWeeklyServiceTable(
  currentServices: ServiceCost[],
  previousServices: ServiceCost[],
  totalCost: number,
): SlackBlock {
  // Create a map of previous week costs for comparison (key: service+region)
  const prevCostMap = new Map<string, number>();
  previousServices.forEach((s) => {
    const key = `${s.service}|${s.region || "global"}`;
    prevCostMap.set(key, s.cost);
  });

  // Header row with Region column
  const headerRow: TableRow = [
    createCell("#", true),
    createCell("Service", true),
    createCell("Region", true),
    createCell("Cost", true),
    createCell("Forecast", true),
    createCell("Share", true),
    createCell("Trend", true),
  ];

  // Data rows
  const dataRows: TableRow[] = currentServices.map((s, i) => {
    const share = `${((s.cost / totalCost) * 100).toFixed(1)}%`;

    // Calculate trend using service+region key
    const key = `${s.service}|${s.region || "global"}`;
    const prevCost = prevCostMap.get(key) || 0;
    let trend = "NEW";
    if (prevCost > 0) {
      const change = ((s.cost - prevCost) / prevCost) * 100;
      if (change > 0) trend = `+${change.toFixed(0)}%`;
      else if (change < 0) trend = `${change.toFixed(0)}%`;
      else trend = "0%";
    }

    return [
      createCell(String(i + 1)),
      createCell(s.service),
      createCell(formatRegion(s.region || "")),
      createCell(formatCurrency(s.cost)),
      createCell(s.forecast ? formatCurrency(s.forecast) : "-"),
      createCell(share),
      createCell(trend),
    ];
  });

  return {
    type: "table",
    rows: [headerRow, ...dataRows],
  };
}

// Build monthly services table using Slack's native table block
function buildMonthlyServiceTable(
  services: ServiceCost[],
  totalCost: number,
  daysElapsed: number,
  budget: number,
): SlackBlock {
  // Header row with Region column
  const headerRow: TableRow = [
    createCell("#", true),
    createCell("Service", true),
    createCell("Region", true),
    createCell("Cost", true),
    createCell("Daily Avg", true),
    createCell("Share", true),
    createCell("Budget%", true),
  ];

  // Data rows
  const dataRows: TableRow[] = services.map((s, i) => {
    const dailyAvg = formatCurrency(s.cost / Math.max(1, daysElapsed));
    const share = `${((s.cost / totalCost) * 100).toFixed(1)}%`;
    const budgetPct = `${((s.cost / budget) * 100).toFixed(1)}%`;

    return [
      createCell(String(i + 1)),
      createCell(s.service),
      createCell(formatRegion(s.region || "")),
      createCell(formatCurrency(s.cost)),
      createCell(dailyAvg),
      createCell(share),
      createCell(budgetPct),
    ];
  });

  return {
    type: "table",
    rows: [headerRow, ...dataRows],
  };
}

// Build unused resources table using Slack's native table block
function buildUnusedResourcesTable(
  unusedResources: UnusedResource[],
): SlackBlock {
  // Header row
  const headerRow: TableRow = [
    createCell("#", true),
    createCell("Service", true),
    createCell("Resource", true),
    createCell("Region", true),
    createCell("Reason", true),
  ];

  // Data rows (limit to 10 for readability)
  const dataRows: TableRow[] = unusedResources.slice(0, 10).map((r, i) => {
    // Truncate resource name/id if too long
    const resourceDisplay = r.resourceName
      ? r.resourceName.length > 20
        ? r.resourceName.substring(0, 17) + "..."
        : r.resourceName
      : r.resourceId.length > 20
        ? r.resourceId.substring(0, 17) + "..."
        : r.resourceId;

    return [
      createCell(String(i + 1)),
      createCell(r.service),
      createCell(resourceDisplay),
      createCell(formatRegion(r.region)),
      createCell(r.reason),
    ];
  });

  return {
    type: "table",
    rows: [headerRow, ...dataRows],
  };
}

// Build unused resources section for the report
export function buildUnusedResourcesSection(
  unusedResources: UnusedResource[],
): SlackBlock[] {
  const blocks: SlackBlock[] = [{ type: "divider" }];

  // Show positive message when no unused resources found
  if (!unusedResources || unusedResources.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*:white_check_mark: Resource Utilization Check*",
      },
    });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "_No idle or unused resources detected across all regions. All resources appear to be actively utilized._",
        },
      ],
    });
    return blocks;
  }

  // Show warning with unused resources table
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*:warning: Potentially Unused Resources (Charged but Idle)*",
    },
  });
  blocks.push(buildUnusedResourcesTable(unusedResources));
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `_Found ${unusedResources.length} potentially unused resource${unusedResources.length > 1 ? "s" : ""}. Consider reviewing these to reduce costs._`,
      },
    ],
  });

  return blocks;
}

export async function sendSlackMessage(message: SlackMessage): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    throw new Error("SLACK_WEBHOOK_URL environment variable is not set");
  }

  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    throw new Error(`Slack API returned status ${response.status}`);
  }
}

export function buildWeeklyReportMessage(data: WeeklyReportData): SlackMessage {
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "AWS Weekly Cost Report",
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Total Spend:*\n${formatCurrency(data.currentWeek.totalCost)}`,
        },
        {
          type: "mrkdwn",
          text: `*Period:*\n${formatDateDisplay(data.currentWeek.startDate)} - ${formatDateDisplay(data.currentWeek.endDate)}`,
        },
      ],
    },
  ];

  // Add week-over-week change
  const changeEmoji =
    data.percentChange >= 0
      ? ":chart_with_upwards_trend:"
      : ":chart_with_downwards_trend:";
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Week-over-Week Change:* ${changeEmoji} ${formatPercentDisplay(data.percentChange)} (Previous: ${formatCurrency(data.previousWeek.totalCost)})`,
    },
  });

  // Add anomaly warning if detected
  if (data.isAnomaly) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":warning: *Anomaly Detected:* Spending increased significantly compared to last week!",
      },
    });
  }

  // Add divider before table
  blocks.push({ type: "divider" });

  // Add services table header
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*:bar_chart: Top Services Breakdown*",
    },
  });

  // Add service table
  if (data.currentWeek.topServices.length > 0) {
    const serviceTable = buildWeeklyServiceTable(
      data.currentWeek.topServices,
      data.previousWeek.topServices,
      data.currentWeek.totalCost,
    );
    blocks.push(serviceTable);

    // Add legend
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "_Forecast = projected monthly cost | Trend = vs last week | NEW = not in top last week_",
        },
      ],
    });
  }

  // Add unused resources section (always show - even if 0 found)
  const unusedBlocks = buildUnusedResourcesSection(
    data.currentWeek.unusedResources || [],
  );
  blocks.push(...unusedBlocks);

  return { blocks };
}

export function buildMonthlyReportMessage(
  data: MonthlyReportData,
): SlackMessage {
  const forecastedTotal = data.monthToDate.totalCost + data.forecast;
  const budgetStatus =
    forecastedTotal > data.budget ? "Over Budget" : "On Track";
  const budgetEmoji =
    forecastedTotal > data.budget ? ":x:" : ":white_check_mark:";
  const budgetUsedPct = (
    (data.monthToDate.totalCost / data.budget) *
    100
  ).toFixed(1);

  // Calculate days elapsed in month
  const startDate = new Date(data.monthToDate.startDate);
  const endDate = new Date(data.monthToDate.endDate);
  const daysElapsed = Math.max(
    1,
    Math.ceil(
      (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
    ),
  );

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "AWS Monthly Cost Forecast",
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Month-to-Date:*\n${formatCurrency(data.monthToDate.totalCost)}`,
        },
        {
          type: "mrkdwn",
          text: `*Forecasted Total:*\n${formatCurrency(forecastedTotal)}`,
        },
      ],
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Month:*\n${data.month} ${data.year}`,
        },
        {
          type: "mrkdwn",
          text: `*Budget:*\n${formatCurrency(data.budget)}`,
        },
      ],
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Budget Used:*\n${budgetUsedPct}%`,
        },
        {
          type: "mrkdwn",
          text: `*Days Elapsed:*\n${daysElapsed} days`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Budget Status:* ${budgetEmoji} ${budgetStatus}`,
      },
    },
  ];

  // Add over budget warning
  if (data.isOverBudget) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":rotating_light: *Warning:* Forecasted spending exceeds the monthly budget!",
      },
    });
  }

  // Add divider before table
  blocks.push({ type: "divider" });

  // Add services table header
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*:bar_chart: Top Services Breakdown*",
    },
  });

  // Add service table
  if (data.monthToDate.topServices.length > 0) {
    const serviceTable = buildMonthlyServiceTable(
      data.monthToDate.topServices,
      data.monthToDate.totalCost,
      daysElapsed,
      data.budget,
    );
    blocks.push(serviceTable);

    // Add legend
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "_Daily Avg = cost/day | Share = % of total | Budget% = % of monthly budget_",
        },
      ],
    });
  }

  // Add unused resources section (always show - even if 0 found)
  const unusedBlocks = buildUnusedResourcesSection(
    data.monthToDate.unusedResources || [],
  );
  blocks.push(...unusedBlocks);

  return { blocks };
}

export async function sendWeeklyReport(data: WeeklyReportData): Promise<void> {
  const message = buildWeeklyReportMessage(data);
  await sendSlackMessage(message);
}

export async function sendMonthlyReport(
  data: MonthlyReportData,
): Promise<void> {
  const message = buildMonthlyReportMessage(data);
  await sendSlackMessage(message);
}
