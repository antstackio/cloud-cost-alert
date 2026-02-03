# Cloud Cost Alerts

A **serverless AWS cost monitoring system** that automatically sends weekly and monthly cost reports to Slack, detects unused resources across multiple AWS services and regions, and supports organization-mode scanning with cost aggregation across linked AWS accounts.

## Features

**Automated Cost Reporting**
- Weekly AWS cost summaries (every Monday at 9:00 AM IST)
- Monthly cost forecasts and budget comparisons (1st of each month at 10:00 AM IST)
- Top spending services highlighted
- Cost anomaly detection with configurable thresholds

**Unused Resource Detection**
- Scans 17 AWS regions for idle or unused resources
- Detects low-CPU EC2 instances, unattached EBS volumes, orphaned snapshots
- Identifies idle RDS instances, load balancers with no traffic, unattached Elastic IPs
- Checks NAT Gateways, EFS, EKS, ECS, ElastiCache, Redshift, and OpenSearch
- Flags old/orphaned EBS snapshots, RDS snapshots, and EFS backups

**Organization Mode (Multi-Account)**
- Supports scanning multiple AWS accounts via STS AssumeRole
- Configurable linked accounts (comma-separated account IDs)
- Cost data grouped by linked account and service in organization mode
- Includes a ready-to-deploy CloudFormation template for the cross-account IAM role
- Falls back to single-account mode when no child accounts are configured

**Slack Notifications**
- Native Slack Block Kit tables for rich formatting
- Separate cost report and unused resources messages
- Budget threshold alerts
- Organization mode shows account IDs per service/resource

**Serverless & Cost-Effective**
- Single Lambda function handles both weekly and monthly reports
- EventBridge Scheduler for cron-based triggers
- Near-zero infrastructure cost
- No databases or persistent storage required
- Infrastructure as Code using AWS SAM

## Prerequisites

- **AWS Account** with Cost Explorer enabled
- **Node.js 20.x** or higher
- **AWS SAM CLI** installed ([Installation Guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html))
- **Slack Workspace** with an incoming webhook

## Quick Start

### 1. Clone and Install

```bash
git clone <repository-url>
cd cloud-cost-alerts
npm install
```

### 2. Configure Environment Variables

Copy the example environment file:

```bash
cp example.env.json env.json
```

Edit `env.json` with your configuration:

```json
{
  "CostReporterFunction": {
    "SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/YOUR/WEBHOOK/URL",
    "MONTHLY_BUDGET": "500",
    "ANOMALY_THRESHOLD": "20"
  }
}
```

### 3. Set SAM Configuration

Edit `samconfig.toml` with your AWS details or run guided deployment:

```bash
npm run deploy:guided
```

### 4. Build and Deploy

```bash
npm run deploy
```

## Environment Variables

| Variable                   | Description                                          | Default              |
| -------------------------- | ---------------------------------------------------- | -------------------- |
| `SLACK_WEBHOOK_URL`        | Slack incoming webhook URL                           | Required             |
| `MONTHLY_BUDGET`           | Monthly budget threshold (USD)                       | 500                  |
| `ANOMALY_THRESHOLD`        | Cost increase threshold to flag anomaly (%)          | 20                   |
| `TOP_SERVICES_COUNT`       | Number of top services to include in report          | 10                   |
| `UNUSED_SERVICES_COUNT`    | Number of unused resources to show in report         | 50                   |
| `SNAPSHOT_AGE_THRESHOLD_DAYS` | Days after which a snapshot is flagged as old      | 90                   |
| `CHILD_ACCOUNTS`           | Comma-separated child account IDs                    | Empty (single-account) |
| `CROSS_ACCOUNT_ROLE_NAME`  | IAM role name to assume in child accounts            | CostAlertsReadRole   |
| `ENABLE_ORGANIZATION_MODE` | Whether to run in organization mode (true/false)     | true                 |
| `REGION`                   | AWS region                                           | Auto-detected        |

## Project Structure

```
cloud-cost-alerts/
├── src/
│   ├── handlers/
│   │   └── cost-reporter.ts          # Main Lambda entry point
│   ├── services/
│   │   ├── cost-explorer.ts          # AWS Cost Explorer API integration
│   │   ├── slack.ts                  # Slack notification service
│   │   └── unused-resources.ts       # Unused resource detection (multi-region, multi-account)
│   ├── utils/
│   │   ├── date-utils.ts             # Date manipulation helpers
│   │   └── formatter.ts              # Message formatting utilities
│   └── types/
│       └── index.ts                  # TypeScript type definitions
├── events/
│   ├── weekly.json                   # Weekly report test event
│   └── monthly.json                  # Monthly report test event
├── cross-account-role.yaml           # CloudFormation template for child account IAM role
├── template.yaml                     # AWS SAM CloudFormation template
├── samconfig.toml                    # SAM deployment config
├── package.json                      # Dependencies
└── tsconfig.json                     # TypeScript config
```

## Available Commands

### Development

```bash
# Build the project
npm run build

# Watch mode (rebuild on file changes)
npm run build:watch

# Clean build artifacts
npm run clean
```

### Testing

```bash
# Test weekly report locally
npm run test:weekly

# Test monthly report locally
npm run test:monthly
```

### Deployment

```bash
# Deploy to development environment
npm run deploy

# Deploy to production environment
npm run deploy:prod

# Guided deployment (interactive setup)
npm run deploy:guided
```

## How It Works

### Scheduling

The system uses **EventBridge Scheduler** for cron-based triggers:

| Schedule | Cron Expression        | Purpose                      |
| -------- | ---------------------- | ---------------------------- |
| Weekly   | `cron(30 3 ? * MON *)` | Monday at 9:00 AM IST        |
| Monthly  | `cron(30 4 1 * ? *)`   | 1st of month at 10:00 AM IST |

### Architecture Flow

```
EventBridge (Scheduler)
    ↓
Lambda Function
    ↓
  ┌─────────────────────────────┐
  │  AWS Cost Explorer API      │  ← cost data & forecasts
  │  CloudWatch Metrics         │  ← resource utilization
  │  AWS Service APIs (EC2,     │  ← resource inventory
  │    RDS, ELB, EKS, ECS...)  │
  │  STS AssumeRole (optional)  │  ← cross-account access
  └─────────────────────────────┘
    ↓
Slack Notification
```

### Report Contents

**Weekly Report** (sent as two Slack messages):
1. Cost report: total spending, top services breakdown with forecasts and week-over-week trends, anomaly detection
2. Unused resources report: idle/unused resources detected across all regions

**Monthly Report** (sent as two Slack messages):
1. Cost report: month-to-date spending, forecasted total, budget comparison, top services with daily averages
2. Unused resources report: idle/unused resources detected across all regions

In organization mode, both reports include account IDs alongside each service and resource entry.

### Unused Resource Detection

The system scans 17 AWS regions (in batches of 4 for performance) and checks the following resources using CloudWatch metrics:

| Resource Type       | Detection Criteria                            |
| ------------------- | --------------------------------------------- |
| EC2 Instances       | CPU < 5% avg or no network traffic            |
| EBS Volumes         | Unattached or zero I/O operations             |
| EBS Snapshots       | Orphaned (source volume deleted) or old (90d+)|
| RDS Instances       | No connections or CPU < 5% avg                |
| RDS Snapshots       | Orphaned (source DB deleted) or old (90d+)    |
| RDS Cluster Snapshots | Orphaned (source cluster deleted) or old    |
| EFS Backups         | Orphaned (source EFS deleted) or old (90d+)   |
| Load Balancers      | No traffic (ALB/NLB)                          |
| Elastic IPs         | Not associated with any instance              |
| NAT Gateways        | No outbound traffic                           |
| EFS File Systems    | No client connections                         |
| EKS Clusters        | No nodes or CPU < 5% avg                      |
| ECS Services        | No running tasks or CPU < 5% avg              |
| ElastiCache         | No connections or CPU < 5% avg                |
| Redshift Clusters   | No connections or CPU < 5% avg                |
| OpenSearch Domains  | No search requests or CPU < 5% avg            |

## Organization Mode (Multi-Account Setup)

To scan resources and aggregate costs across multiple AWS accounts:

### 1. Deploy the cross-account role in each child account

Use the provided `cross-account-role.yaml` template:

```bash
aws cloudformation deploy \
  --template-file cross-account-role.yaml \
  --stack-name cost-alerts-read-role \
  --parameter-overrides ManagementAccountId=<YOUR_PARENT_ACCOUNT_ID> \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1
```

### 2. Configure child accounts

Add the `CHILD_ACCOUNTS` parameter during deployment with comma-separated account IDs:

```bash
# In samconfig.toml parameter_overrides, add:
ChildAccounts="123456789012,987654321098"
```

Or pass it via SAM deploy:

```bash
sam deploy --parameter-overrides \
  ChildAccounts="123456789012,987654321098" \
  SlackWebhookUrl="https://hooks.slack.com/services/..."
```

Organization mode is automatically enabled when `CHILD_ACCOUNTS` is configured with at least one account ID. In this mode, cost data is grouped by linked account and service, and unused resource reports include account IDs.

## Local Testing

Before deploying, test locally using SAM:

```bash
# Test weekly report
npm run test:weekly

# Test monthly report
npm run test:monthly
```

Make sure you have AWS credentials configured and `env.json` properly set up.

## Slack Webhook Setup

1. Go to your Slack workspace settings
2. Create an **Incoming Webhook** integration
3. Copy the webhook URL
4. Add it to your `env.json` as `SLACK_WEBHOOK_URL`

[Learn more about Slack webhooks](https://api.slack.com/messaging/webhooks)

## IAM Permissions

The Lambda function requires the following AWS IAM permissions (all configured in `template.yaml`):

- **Cost Explorer**: `ce:GetCostAndUsage`, `ce:GetCostForecast`
- **STS**: `sts:GetCallerIdentity`, `sts:AssumeRole` (for organization mode cross-account access)
- **CloudWatch**: `cloudwatch:GetMetricStatistics`, `cloudwatch:GetMetricData`
- **EC2**: `ec2:DescribeInstances`, `ec2:DescribeVolumes`, `ec2:DescribeRegions`, `ec2:DescribeAddresses`, `ec2:DescribeNatGateways`, `ec2:DescribeSnapshots`
- **RDS**: `rds:DescribeDBInstances`, `rds:DescribeDBSnapshots`, `rds:DescribeDBClusters`, `rds:DescribeDBClusterSnapshots`
- **ELB**: `elasticloadbalancing:DescribeLoadBalancers`
- **EFS**: `elasticfilesystem:DescribeFileSystems`
- **EKS**: `eks:ListClusters`, `eks:DescribeCluster`
- **ECS**: `ecs:ListClusters`, `ecs:ListServices`, `ecs:DescribeServices`
- **ElastiCache**: `elasticache:DescribeCacheClusters`
- **Redshift**: `redshift:DescribeClusters`
- **OpenSearch**: `es:ListDomainNames`, `es:DescribeDomain`
- **AWS Backup**: `backup:ListBackupVaults`, `backup:ListRecoveryPointsByBackupVault`

## Cost Considerations

This solution is designed to be extremely cost-effective:

- **Lambda**: ~$0.20/month (free tier eligible)
- **EventBridge**: ~$0.10/month (free tier eligible)
- **Cost Explorer API**: Free (included with AWS)
- **Total**: Essentially free on AWS free tier

## Troubleshooting

### Lambda Function Not Executing

1. Verify IAM role has correct permissions
2. Check EventBridge rules are enabled
3. Review CloudWatch Logs for errors:
   ```bash
   aws logs tail /aws/lambda/cost-reporter-dev --follow
   ```

### Slack Notifications Not Received

1. Verify `SLACK_WEBHOOK_URL` is correct in environment variables
2. Check Slack workspace allows incoming webhooks
3. Review Lambda logs for HTTP errors

### Cost Data Not Appearing

1. Ensure Cost Explorer is enabled in your AWS account
2. Verify Lambda has `ce:GetCostAndUsage` permissions
3. Cost data takes ~24 hours to appear in Cost Explorer

### Organization Mode / Cross-Account Failures

1. Verify the cross-account role exists in the child account
2. Check that the role trust policy references the correct parent account ID
3. Ensure the `CROSS_ACCOUNT_ROLE_NAME` matches the deployed role name
4. Verify `CHILD_ACCOUNTS` uses comma-separated account IDs (e.g., `123456789012,987654321098`)
5. Review Lambda logs for `AssumeRole` errors

## Configuration Examples

### Single Account (Default)

```
# samconfig.toml parameter_overrides
MonthlyBudget="500" AnomalyThreshold="20" TopServicesCount="10"
```

### Multi-Account Organization

```
# samconfig.toml parameter_overrides
MonthlyBudget="5000" AnomalyThreshold="15" TopServicesCount="10" ChildAccounts="111111111111,222222222222,333333333333"
```

### Strict Anomaly Detection

```
MonthlyBudget="1000" AnomalyThreshold="10" SnapshotAgeThresholdDays="30"
```

## AWS SAM Commands Reference

```bash
# View function logs
sam logs -n CostReporterFunction

# Invoke function directly
sam local invoke CostReporterFunction -e events/weekly.json --env-vars env.json

# Delete stack
sam delete
```

## License

MIT License - see LICENSE file for details.

## Support

For issues, questions, or suggestions, please open an issue in the repository.

---

**Built by Antstack** | [Website](https://antstack.io)
