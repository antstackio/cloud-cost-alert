# Cloud Cost Alerts 📊

A **serverless AWS cost monitoring system** that automatically sends weekly and monthly cost reports to Slack, helping teams proactively track spending and detect anomalies.

## Features

✨ **Automated Cost Reporting**
- Weekly AWS cost summaries (Monday mornings)
- Monthly cost forecasts and budget comparisons
- Top spending services highlighted
- Cost anomaly detection

🔔 **Slack Notifications**
- Beautiful, formatted cost reports
- Budget threshold alerts
- Anomaly warnings

⚡ **Serverless & Cost-Effective**
- Runs on AWS Lambda with minimal overhead
- EventBridge for scheduling
- Near-zero infrastructure cost
- No databases or persistent storage required

🏗️ **Low Maintenance**
- Single Lambda function handles both weekly and monthly reports
- Infrastructure as Code using AWS SAM
- Easy to deploy and configure

## Prerequisites

- **AWS Account** with appropriate permissions
- **Node.js 20.x** or higher
- **AWS SAM CLI** installed ([Installation Guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html))
- **Slack Workspace** with webhook integration

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

| Variable             | Description                                 | Default       |
| -------------------- | ------------------------------------------- | ------------- |
| `SLACK_WEBHOOK_URL`  | Slack incoming webhook URL                  | Required      |
| `MONTHLY_BUDGET`     | Monthly budget threshold (USD)              | 500           |
| `ANOMALY_THRESHOLD`  | Cost increase threshold to flag anomaly (%) | 20            |
| `TOP_SERVICES_COUNT` | Number of top services to include in report | 10            |
| `REGION`             | AWS region                                  | Auto-detected |

## Project Structure

```
cloud-cost-alerts/
├── src/
│   ├── handlers/
│   │   └── cost-reporter.ts          # Main Lambda entry point
│   ├── services/
│   │   ├── cost-explorer.ts          # AWS Cost Explorer API integration
│   │   ├── slack.ts                  # Slack notification service
│   │   └── unused-resources.ts       # Unused resource detection
│   ├── utils/
│   │   ├── date-utils.ts             # Date manipulation helpers
│   │   └── formatter.ts              # Message formatting utilities
│   └── types/
│       └── index.ts                  # TypeScript type definitions
├── events/
│   ├── weekly.json                   # Weekly report event
│   └── monthly.json                  # Monthly report event
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

The system uses **EventBridge** for serverless scheduling:

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
AWS Cost Explorer API
    ↓
Slack Notification
```

### Report Contents

**Weekly Report:**
- Total spending for the past 7 days
- Top 10 services by cost
- Comparison with previous week
- Anomaly detection alerts

**Monthly Report:**
- Month-to-date spending
- Cost forecast for end of month
- Budget comparison
- Top services breakdown

## Local Testing

Before deploying, test locally using SAM:

```bash
# Test weekly report
npm run test:weekly

# Test monthly report
npm run test:monthly
```

Make sure you have the AWS credentials configured and `env.json` properly set up.

## Slack Webhook Setup

1. Go to your Slack workspace settings
2. Create an **Incoming Webhook** integration
3. Copy the webhook URL
4. Add it to your `env.json` as `SLACK_WEBHOOK_URL`

[Learn more about Slack webhooks](https://api.slack.com/messaging/webhooks)

## Permissions Required

The Lambda function requires the following AWS IAM permissions:

- `ce:GetCostAndUsage` - Retrieve cost data
- `ce:GetCostForecast` - Get cost forecasts
- `cloudwatch:GetMetricStatistics` - CloudWatch metrics
- `ec2:Describe*` - EC2 resource inspection
- `rds:DescribeDBInstances` - RDS resource inspection
- `elasticloadbalancing:DescribeLoadBalancers` - ELB resource inspection
- `elasticfilesystem:DescribeFileSystems` - EFS resource inspection
- `eks:ListClusters` - EKS cluster inspection
- `ecs:ListClusters` - ECS cluster inspection

All permissions are configured in `template.yaml` with principle of least privilege.

## Cost Considerations

This solution is designed to be extremely cost-effective:

- **Lambda**: ~0.20 USD/month (free tier included)
- **EventBridge**: ~0.10 USD/month (free tier included)
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

## Configuration Examples

### High-Cost Environment Alert

```json
{
  "MONTHLY_BUDGET": "1000",
  "ANOMALY_THRESHOLD": "10"
}
```

### Development Environment (Relaxed Alerts)

```json
{
  "MONTHLY_BUDGET": "100",
  "ANOMALY_THRESHOLD": "50"
}
```

## AWS SAM Commands Reference

```bash
# View function logs
sam logs -n CostReporterFunction

# Invoke function directly
sam local invoke CostReporterFunction -e events/weekly.json

# Delete stack
sam delete
```

## License

MIT License - see LICENSE file for details

## Support

For issues, questions, or suggestions, please open an issue in the repository.

---

**Built by Antstack** | [Website](https://antstack.io)
