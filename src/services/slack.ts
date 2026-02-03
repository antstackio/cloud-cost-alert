import {
  WeeklyReportData,
  MonthlyReportData,
  SlackMessage,
  SlackBlock,
  ServiceCost,
  UnusedResource,
  RichTextCell,
  TableRow,
} from "../types";
import { formatCurrency, formatPercentDisplay } from "../utils/formatter";
import { formatDateDisplay } from "../utils/date-utils";

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

// Helper to format region name for display
function formatRegion(region: string): string {
  if (!region || region === "global") return "Global";
  return region;
}

// Helper to truncate service name for table display
function truncateServiceName(name: string, maxLen: number = 20): string {
  if (name.length <= maxLen) return name;
  return name.substring(0, maxLen - 2) + "..";
}

// Helper to create a rich text cell for Block Kit table
function createTextCell(text: string, bold: boolean = false): RichTextCell {
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          {
            type: "text",
            text: text,
            ...(bold && { style: { bold: true } }),
          },
        ],
      },
    ],
  };
}

// Helper to create a table row from an array of strings
function createTableRow(cells: string[], bold: boolean = false): TableRow {
  return cells.map((text) => createTextCell(text, bold));
}

// Build weekly services table using native Slack Block Kit table format
function buildWeeklyServiceTable(
  currentServices: ServiceCost[],
  previousServices: ServiceCost[],
  totalCost: number,
  isOrganizationMode: boolean = false,
): SlackBlock {
  // Create a map of previous week costs for comparison (key: service+account)
  const prevCostMap = new Map<string, number>();
  previousServices.forEach((s) => {
    const key = `${s.service}|${s.accountId || ""}`;
    prevCostMap.set(key, s.cost);
  });

  // Build table rows
  const tableRows: TableRow[] = [];

  // Header row
  const headerCells = isOrganizationMode
    ? ["#", "Service", "Cost", "Forecast", "Share", "Trend", "Account ID", "Region"]
    : ["#", "Service", "Cost", "Forecast", "Share", "Trend", "Region"];
  tableRows.push(createTableRow(headerCells, true));

  // Data rows
  currentServices.forEach((s, i) => {
    const share = `${((s.cost / totalCost) * 100).toFixed(1)}%`;

    // Calculate trend
    const key = `${s.service}|${s.accountId || ""}`;
    const prevCost = prevCostMap.get(key) || 0;
    let trend = "NEW";
    if (prevCost > 0) {
      const change = ((s.cost - prevCost) / prevCost) * 100;
      if (change > 0) trend = `↑+${change.toFixed(0)}%`;
      else if (change < 0) trend = `↓${change.toFixed(0)}%`;
      else trend = "→0%";
    }

    const forecast = s.forecast ? formatCurrency(s.forecast) : "-";
    const serviceName = truncateServiceName(s.service, 25);
    const costStr = formatCurrency(s.cost);
    const region = formatRegion(s.region || "");

    const rowCells = isOrganizationMode
      ? [
          String(i + 1),
          serviceName,
          costStr,
          forecast,
          share,
          trend,
          s.accountId || "-",
          region,
        ]
      : [String(i + 1), serviceName, costStr, forecast, share, trend, region];

    tableRows.push(createTableRow(rowCells, false));
  });

  return {
    type: "table",
    rows: tableRows,
  };
}

// Build monthly services table using native Slack Block Kit table format
function buildMonthlyServiceTable(
  services: ServiceCost[],
  totalCost: number,
  daysElapsed: number,
  budget: number,
  isOrganizationMode: boolean = false,
): SlackBlock {
  // Build table rows
  const tableRows: TableRow[] = [];

  // Header row
  const headerCells = isOrganizationMode
    ? ["#", "Service", "Cost", "Daily Avg", "Share", "Budget%", "Account ID", "Region"]
    : ["#", "Service", "Cost", "Daily Avg", "Share", "Budget%", "Region"];
  tableRows.push(createTableRow(headerCells, true));

  // Data rows
  services.forEach((s, i) => {
    const dailyAvg = formatCurrency(s.cost / Math.max(1, daysElapsed));
    const share = `${((s.cost / totalCost) * 100).toFixed(1)}%`;
    const budgetPct = `${((s.cost / budget) * 100).toFixed(1)}%`;
    const serviceName = truncateServiceName(s.service, 25);
    const costStr = formatCurrency(s.cost);
    const region = formatRegion(s.region || "");

    const rowCells = isOrganizationMode
      ? [
          String(i + 1),
          serviceName,
          costStr,
          dailyAvg,
          share,
          budgetPct,
          s.accountId || "-",
          region,
        ]
      : [
          String(i + 1),
          serviceName,
          costStr,
          dailyAvg,
          share,
          budgetPct,
          region,
        ];

    tableRows.push(createTableRow(rowCells, false));
  });

  return {
    type: "table",
    rows: tableRows,
  };
}

// Build unused resources table using native Slack Block Kit table format
function buildUnusedResourcesTable(
  unusedResources: UnusedResource[],
): SlackBlock {
  const tableRows: TableRow[] = [];

  // Detect org mode: show account info if any resource has it
  const isOrgMode = unusedResources.some((r) => r.accountId);

  // Header row
  const headerCells = isOrgMode
    ? ["#", "Service", "Resource", "Region", "Reason", "Account ID"]
    : ["#", "Service", "Resource", "Region", "Reason"];
  tableRows.push(createTableRow(headerCells, true));

  // Data rows (limit to 10 for readability)
  const limitToUnusedCount = Number(process.env.UNUSED_SERVICES_COUNT || 40);
  unusedResources.slice(0, limitToUnusedCount).forEach((r, i) => {
    const resourceDisplay = r.resourceName
      ? r.resourceName.length > 25
        ? r.resourceName.substring(0, 22) + "..."
        : r.resourceName
      : r.resourceId.length > 25
        ? r.resourceId.substring(0, 22) + "..."
        : r.resourceId;

    const region = formatRegion(r.region);

    const rowCells = isOrgMode
      ? [
          String(i + 1),
          r.service,
          resourceDisplay,
          region,
          r.reason,
          r.accountId || "-",
        ]
      : [String(i + 1), r.service, resourceDisplay, region, r.reason];

    tableRows.push(createTableRow(rowCells, false));
  });

  return {
    type: "table",
    rows: tableRows,
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
    const errorBody = await response.text();
    console.error("Slack API error response:", errorBody);
    console.error("Message payload:", JSON.stringify(message, null, 2));
    throw new Error(
      `Slack API returned status ${response.status}: ${errorBody}`,
    );
  }
}

// Helper to format account display (parent/management account ID)
function formatAccountDisplay(accountId: string): string {
  return accountId;
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
          text: `*Account:*\n${formatAccountDisplay(data.accountId)}`,
        },
        {
          type: "mrkdwn",
          text: `*Period:*\n${formatDateDisplay(data.currentWeek.startDate)} - ${formatDateDisplay(data.currentWeek.endDate)}`,
        },
      ],
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
          text: `*Previous Week:*\n${formatCurrency(data.previousWeek.totalCost)}`,
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
      text: `*Week-over-Week Change:* ${changeEmoji} ${formatPercentDisplay(data.percentChange)}`,
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

  // Add organization mode indicator if enabled
  if (data.isOrganizationMode && data.currentWeek.accountCount) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:office: _Organization Mode: Costs aggregated across ${data.currentWeek.accountCount} linked accounts_`,
        },
      ],
    });
  }

  // Add service table
  if (data.currentWeek.topServices.length > 0) {
    const serviceTable = buildWeeklyServiceTable(
      data.currentWeek.topServices,
      data.previousWeek.topServices,
      data.currentWeek.totalCost,
      data.isOrganizationMode,
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
          text: `*Account:*\n${formatAccountDisplay(data.accountId)}`,
        },
        {
          type: "mrkdwn",
          text: `*Month:*\n${data.month} ${data.year}`,
        },
      ],
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
          text: `*Budget:*\n${formatCurrency(data.budget)}`,
        },
        {
          type: "mrkdwn",
          text: `*Budget Used:*\n${budgetUsedPct}%`,
        },
      ],
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Days Elapsed:*\n${daysElapsed} days`,
        },
        {
          type: "mrkdwn",
          text: `*Budget Status:*\n${budgetEmoji} ${budgetStatus}`,
        },
      ],
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

  // Add organization mode indicator if enabled
  if (data.isOrganizationMode && data.monthToDate.accountCount) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:office: _Organization Mode: Costs aggregated across ${data.monthToDate.accountCount} linked accounts_`,
        },
      ],
    });
  }

  // Add service table
  if (data.monthToDate.topServices.length > 0) {
    const serviceTable = buildMonthlyServiceTable(
      data.monthToDate.topServices,
      data.monthToDate.totalCost,
      daysElapsed,
      data.budget,
      data.isOrganizationMode,
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

  return { blocks };
}

// Build a standalone Slack message for unused resources
export function buildUnusedResourcesMessage(
  unusedResources: UnusedResource[],
): SlackMessage {
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "AWS Unused Resources Report",
        emoji: true,
      },
    },
    ...buildUnusedResourcesSection(unusedResources),
  ];

  return { blocks };
}

export async function sendWeeklyReport(data: WeeklyReportData): Promise<void> {
  const message = buildWeeklyReportMessage(data);
  await sendSlackMessage(message);

  const unusedMessage = buildUnusedResourcesMessage(
    data.currentWeek.unusedResources || [],
  );
  await sendSlackMessage(unusedMessage);
}

export async function sendMonthlyReport(
  data: MonthlyReportData,
): Promise<void> {
  const message = buildMonthlyReportMessage(data);
  await sendSlackMessage(message);

  const unusedMessage = buildUnusedResourcesMessage(
    data.monthToDate.unusedResources || [],
  );
  await sendSlackMessage(unusedMessage);
}
