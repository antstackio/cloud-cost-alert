export interface ReportEvent {
  type: 'weekly' | 'monthly';
}

export interface ServiceCost {
  service: string;
  cost: number;
  forecast?: number;
  region?: string;
}

export interface UnusedResource {
  service: string;
  resourceId: string;
  resourceName?: string;
  region: string;
  cost: number;
  reason: string; // e.g., "Low CPU (<5%)", "Zero connections", "No requests"
}

export interface CostData {
  totalCost: number;
  topServices: ServiceCost[];
  startDate: string;
  endDate: string;
  unusedResources?: UnusedResource[];
}

export interface WeeklyReportData {
  currentWeek: CostData;
  previousWeek: CostData;
  percentChange: number;
  isAnomaly: boolean;
}

export interface MonthlyReportData {
  monthToDate: CostData;
  forecast: number;
  budget: number;
  isOverBudget: boolean;
  month: string;
  year: number;
}

export interface DateRange {
  start: string;
  end: string;
}

// Text style for rich text elements
export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

// Text element inside rich_text_section
export interface TextElement {
  type: "text";
  text: string;
  style?: TextStyle;
}

// Rich text section element
export interface RichTextSectionElement {
  type: "rich_text_section";
  elements: TextElement[];
}

// Rich text cell for table
export interface RichTextCell {
  type: "rich_text";
  elements: RichTextSectionElement[];
}

// Table row is an array of cells
export type TableRow = RichTextCell[];

// Flexible Slack block that supports all block types
export interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
  fields?: Array<{
    type: string;
    text: string;
  }>;
  // For context blocks
  elements?: Array<{
    type: string;
    text?: string;
    elements?: Array<{
      type: string;
      text: string;
    }>;
  }>;
  // For table blocks
  rows?: TableRow[];
}

export interface SlackMessage {
  blocks: SlackBlock[];
}
