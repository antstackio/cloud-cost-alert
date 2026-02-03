import { Context } from 'aws-lambda';
import { ReportEvent, WeeklyReportData, MonthlyReportData } from '../types';
import { getCosts, getCostForecast, getAccountId, shouldUseOrganizationMode } from '../services/cost-explorer';
import { detectUnusedResources } from '../services/unused-resources';
import { sendWeeklyReport, sendMonthlyReport } from '../services/slack';
import {
  getWeekDateRange,
  getPreviousWeekDateRange,
  getMonthToDateRange,
  getForecastDateRange,
  getCurrentMonthName,
  getCurrentYear,
} from '../utils/date-utils';
import { formatPercentChange } from '../utils/formatter';

const MONTHLY_BUDGET = parseFloat(process.env.MONTHLY_BUDGET || '500');
const ANOMALY_THRESHOLD = parseFloat(process.env.ANOMALY_THRESHOLD || '20');

async function generateWeeklyReport(): Promise<void> {
  console.log('Generating weekly cost report...');

  const currentWeekRange = getWeekDateRange();
  const previousWeekRange = getPreviousWeekDateRange();

  // Check if organization mode should be enabled
  const useOrgMode = shouldUseOrganizationMode();
  console.log(`Organization mode: ${useOrgMode ? 'enabled' : 'disabled'}`);

  // Fetch costs, detect unused resources, and get account ID in parallel
  const [currentWeekCosts, previousWeekCosts, unusedResources, accountId] = await Promise.all([
    getCosts(currentWeekRange, { includeForecasts: true, groupByAccount: useOrgMode }),
    getCosts(previousWeekRange, { groupByAccount: useOrgMode }),
    detectUnusedResources(currentWeekRange),
    getAccountId(),
  ]);

  // Attach unused resources to current week data
  currentWeekCosts.unusedResources = unusedResources;

  const percentChange = formatPercentChange(
    currentWeekCosts.totalCost,
    previousWeekCosts.totalCost
  );

  const isAnomaly = percentChange > ANOMALY_THRESHOLD;

  const reportData: WeeklyReportData = {
    currentWeek: currentWeekCosts,
    previousWeek: previousWeekCosts,
    percentChange,
    isAnomaly,
    accountId,
    isOrganizationMode: useOrgMode,
  };

  console.log('Weekly report data:', JSON.stringify(reportData, null, 2));
  console.log(`Found ${unusedResources.length} potentially unused resources`);

  await sendWeeklyReport(reportData);
  console.log('Weekly report sent successfully');
}

async function generateMonthlyReport(): Promise<void> {
  console.log('Generating monthly cost forecast...');

  const monthToDateRange = getMonthToDateRange();
  const forecastRange = getForecastDateRange();

  // Check if organization mode should be enabled
  const useOrgMode = shouldUseOrganizationMode();
  console.log(`Organization mode: ${useOrgMode ? 'enabled' : 'disabled'}`);

  // Fetch costs, forecast, detect unused resources, and get account ID in parallel
  const [monthToDateCosts, forecast, unusedResources, accountId] = await Promise.all([
    getCosts(monthToDateRange, { groupByAccount: useOrgMode }),
    getCostForecast(forecastRange),
    detectUnusedResources(monthToDateRange),
    getAccountId(),
  ]);

  // Attach unused resources to month-to-date data
  monthToDateCosts.unusedResources = unusedResources;

  const forecastedTotal = monthToDateCosts.totalCost + forecast;
  const isOverBudget = forecastedTotal > MONTHLY_BUDGET;

  const reportData: MonthlyReportData = {
    monthToDate: monthToDateCosts,
    forecast,
    budget: MONTHLY_BUDGET,
    isOverBudget,
    month: getCurrentMonthName(),
    year: getCurrentYear(),
    accountId,
    isOrganizationMode: useOrgMode,
  };

  console.log('Monthly report data:', JSON.stringify(reportData, null, 2));
  console.log(`Found ${unusedResources.length} potentially unused resources`);

  await sendMonthlyReport(reportData);
  console.log('Monthly report sent successfully');
}

export const handler = async (
  event: ReportEvent,
  context: Context
): Promise<{ statusCode: number; body: string }> => {
  console.log('Event received:', JSON.stringify(event));
  console.log('Context:', JSON.stringify(context));

  try {
    const reportType = event.type;

    if (reportType === 'weekly') {
      await generateWeeklyReport();
    } else if (reportType === 'monthly') {
      await generateMonthlyReport();
    } else {
      throw new Error(`Unknown report type: ${reportType}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `${reportType} report generated successfully`,
      }),
    };
  } catch (error) {
    console.error('Error generating report:', error);
    throw error;
  }
};
