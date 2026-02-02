import { DateRange } from '../types';

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function getWeekDateRange(): DateRange {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 7);

  return {
    start: formatDate(start),
    end: formatDate(end),
  };
}

export function getPreviousWeekDateRange(): DateRange {
  const end = new Date();
  end.setDate(end.getDate() - 7);
  const start = new Date(end);
  start.setDate(end.getDate() - 7);

  return {
    start: formatDate(start),
    end: formatDate(end),
  };
}

export function getMonthToDateRange(): DateRange {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);

  return {
    start: formatDate(start),
    end: formatDate(now),
  };
}

export function getForecastDateRange(): DateRange {
  const now = new Date();
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  return {
    start: formatDate(now),
    end: formatDate(endOfMonth),
  };
}

export function formatDateDisplay(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function getCurrentMonthName(): string {
  const now = new Date();
  return now.toLocaleDateString('en-US', { month: 'long' });
}

export function getCurrentYear(): number {
  return new Date().getFullYear();
}
