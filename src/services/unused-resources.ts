import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DescribeAddressesCommand,
  DescribeNatGatewaysCommand,
  DescribeSnapshotsCommand,
} from "@aws-sdk/client-ec2";
import {
  RDSClient,
  DescribeDBInstancesCommand,
  DescribeDBClustersCommand,
  paginateDescribeDBSnapshots,
  paginateDescribeDBClusterSnapshots,
  DBSnapshot,
  DBClusterSnapshot,
} from "@aws-sdk/client-rds";
import {
  BackupClient,
  ListBackupVaultsCommand,
  ListRecoveryPointsByBackupVaultCommand,
} from "@aws-sdk/client-backup";
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { EFSClient, DescribeFileSystemsCommand } from "@aws-sdk/client-efs";
import {
  EKSClient,
  ListClustersCommand,
  DescribeClusterCommand,
} from "@aws-sdk/client-eks";
import {
  ECSClient,
  ListClustersCommand as ECSListClustersCommand,
  ListServicesCommand,
  DescribeServicesCommand,
} from "@aws-sdk/client-ecs";
import {
  ElastiCacheClient,
  DescribeCacheClustersCommand,
} from "@aws-sdk/client-elasticache";
import {
  RedshiftClient,
  DescribeClustersCommand as RedshiftDescribeClustersCommand,
} from "@aws-sdk/client-redshift";
import {
  OpenSearchClient,
  ListDomainNamesCommand,
  DescribeDomainCommand,
} from "@aws-sdk/client-opensearch";
import { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { UnusedResource, DateRange, AwsCredentials } from "../types";
import { getConfiguredAccounts, shouldUseOrganizationMode, getAccountId } from "./cost-explorer";

// All AWS regions to check
const AWS_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ap-south-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-southeast-1",
  "ap-southeast-2",
  "ca-central-1",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "sa-east-1",
  // 'me-south-1',
  // 'af-south-1',
];

// Thresholds for determining unused resources
const CPU_THRESHOLD = 5; // Average CPU below 5% is considered idle
const NETWORK_THRESHOLD = 1000; // Less than 1KB/s is considered idle
const CONNECTIONS_THRESHOLD = 1; // Less than 1 connection is considered idle
const SNAPSHOT_AGE_THRESHOLD_DAYS = Number(
  process.env.SNAPSHOT_AGE_THRESHOLD_DAYS || "90",
); // Snapshots older than this are flagged

const CROSS_ACCOUNT_ROLE_NAME = process.env.CROSS_ACCOUNT_ROLE_NAME || "CostAlertsReadRole";

// Helper to build client config with optional cross-account credentials
function clientConfig(region: string, credentials?: AwsCredentials) {
  return { region, ...(credentials && { credentials }) };
}

// Assume a role in a child account and return temporary credentials
async function assumeRole(accountId: string): Promise<AwsCredentials | null> {
  const roleArn = `arn:aws:iam::${accountId}:role/${CROSS_ACCOUNT_ROLE_NAME}`;
  const stsClient = new STSClient({ region: "us-east-1" });

  try {
    const response = await stsClient.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `cost-alerts-${accountId}`,
        DurationSeconds: 900,
      }),
    );

    if (!response.Credentials?.AccessKeyId || !response.Credentials?.SecretAccessKey) {
      console.warn(`AssumeRole returned no credentials for account ${accountId}`);
      return null;
    }

    return {
      accessKeyId: response.Credentials.AccessKeyId,
      secretAccessKey: response.Credentials.SecretAccessKey,
      sessionToken: response.Credentials.SessionToken,
    };
  } catch (error) {
    console.warn(`Failed to assume role in account ${accountId}:`, (error as Error).message);
    return null;
  }
}

async function getCloudWatchMetric(
  client: CloudWatchClient,
  namespace: string,
  metricName: string,
  dimensions: { Name: string; Value: string }[],
  dateRange: DateRange,
): Promise<number> {
  try {
    // Ensure end date includes today by adding 1 day to capture current day's metrics
    const endDate = new Date(dateRange.end);
    endDate.setDate(endDate.getDate() + 1);

    const command = new GetMetricStatisticsCommand({
      Namespace: namespace,
      MetricName: metricName,
      Dimensions: dimensions,
      StartTime: new Date(dateRange.start),
      EndTime: endDate,
      Period: 86400, // 1 day
      Statistics: ["Average"],
    });

    const response = await client.send(command);
    if (response.Datapoints && response.Datapoints.length > 0) {
      const sum = response.Datapoints.reduce(
        (acc, dp) => acc + (dp.Average || 0),
        0,
      );
      return sum / response.Datapoints.length;
    }
    // No datapoints - return -2 to indicate "no data" (different from error which is -1)
    // This allows callers to distinguish between "metric returned 0" and "no metrics available"
    return -2;
  } catch (error) {
    console.warn(`Failed to get CloudWatch metric ${metricName}:`, error);
    return -1;
  }
}

// Get Sum metric (for counts like requests, bytes)
async function getCloudWatchSumMetric(
  client: CloudWatchClient,
  namespace: string,
  metricName: string,
  dimensions: { Name: string; Value: string }[],
  dateRange: DateRange,
): Promise<number> {
  try {
    // Ensure end date includes today
    const endDate = new Date(dateRange.end);
    endDate.setDate(endDate.getDate() + 1);

    const command = new GetMetricStatisticsCommand({
      Namespace: namespace,
      MetricName: metricName,
      Dimensions: dimensions,
      StartTime: new Date(dateRange.start),
      EndTime: endDate,
      Period: 86400,
      Statistics: ["Sum"],
    });

    const response = await client.send(command);
    if (response.Datapoints && response.Datapoints.length > 0) {
      return response.Datapoints.reduce((acc, dp) => acc + (dp.Sum || 0), 0);
    }
    // No datapoints - return -2 to indicate "no data"
    return -2;
  } catch (error) {
    console.warn(`Failed to get CloudWatch sum metric ${metricName}:`, error);
    return -1;
  }
}

async function checkEC2Instances(
  region: string,
  dateRange: DateRange,
  credentials?: AwsCredentials,
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const ec2Client = new EC2Client(clientConfig(region, credentials));
  const cwClient = new CloudWatchClient(clientConfig(region, credentials));

  try {
    const command = new DescribeInstancesCommand({
      Filters: [{ Name: "instance-state-name", Values: ["running"] }],
    });
    const response = await ec2Client.send(command);

    for (const reservation of response.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        const instanceId = instance.InstanceId || "";
        const instanceName =
          instance.Tags?.find((t) => t.Key === "Name")?.Value || instanceId;

        const cpuAvg = await getCloudWatchMetric(
          cwClient,
          "AWS/EC2",
          "CPUUtilization",
          [{ Name: "InstanceId", Value: instanceId }],
          dateRange,
        );

        if (cpuAvg >= 0 && cpuAvg < CPU_THRESHOLD) {
          unusedResources.push({
            service: "Amazon EC2",
            resourceId: instanceId,
            resourceName: instanceName,
            region,
            cost: 0,
            reason: `Low CPU (${cpuAvg.toFixed(1)}% avg)`,
          });
          continue;
        }

        const networkIn = await getCloudWatchMetric(
          cwClient,
          "AWS/EC2",
          "NetworkIn",
          [{ Name: "InstanceId", Value: instanceId }],
          dateRange,
        );
        const networkOut = await getCloudWatchMetric(
          cwClient,
          "AWS/EC2",
          "NetworkOut",
          [{ Name: "InstanceId", Value: instanceId }],
          dateRange,
        );

        if (
          networkIn >= 0 &&
          networkOut >= 0 &&
          networkIn < NETWORK_THRESHOLD &&
          networkOut < NETWORK_THRESHOLD
        ) {
          unusedResources.push({
            service: "Amazon EC2",
            resourceId: instanceId,
            resourceName: instanceName,
            region,
            cost: 0,
            reason: "No network traffic",
          });
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to check EC2 instances in ${region}:`, error);
  }

  return unusedResources;
}

async function checkEBSVolumes(
  region: string,
  dateRange: DateRange,
  credentials?: AwsCredentials,
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const ec2Client = new EC2Client(clientConfig(region, credentials));
  const cwClient = new CloudWatchClient(clientConfig(region, credentials));

  try {
    const command = new DescribeVolumesCommand({});
    const response = await ec2Client.send(command);

    for (const volume of response.Volumes || []) {
      const volumeId = volume.VolumeId || "";
      const volumeName =
        volume.Tags?.find((t) => t.Key === "Name")?.Value || volumeId;

      if (!volume.Attachments || volume.Attachments.length === 0) {
        unusedResources.push({
          service: "Amazon EBS",
          resourceId: volumeId,
          resourceName: volumeName,
          region,
          cost: 0,
          reason: "Unattached volume",
        });
        continue;
      }

      const readOps = await getCloudWatchMetric(
        cwClient,
        "AWS/EBS",
        "VolumeReadOps",
        [{ Name: "VolumeId", Value: volumeId }],
        dateRange,
      );
      const writeOps = await getCloudWatchMetric(
        cwClient,
        "AWS/EBS",
        "VolumeWriteOps",
        [{ Name: "VolumeId", Value: volumeId }],
        dateRange,
      );

      if (readOps >= 0 && writeOps >= 0 && readOps === 0 && writeOps === 0) {
        unusedResources.push({
          service: "Amazon EBS",
          resourceId: volumeId,
          resourceName: volumeName,
          region,
          cost: 0,
          reason: "No I/O operations",
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to check EBS volumes in ${region}:`, error);
  }

  return unusedResources;
}

async function checkEBSSnapshots(region: string, credentials?: AwsCredentials): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const ec2Client = new EC2Client(clientConfig(region, credentials));

  try {
    // Get all snapshots owned by this account
    const snapshotsCommand = new DescribeSnapshotsCommand({
      OwnerIds: ["self"],
    });
    const snapshotsResponse = await ec2Client.send(snapshotsCommand);

    // Debug logging to see what EBS snapshots are returned
    const snapshotCount = snapshotsResponse.Snapshots?.length || 0;
    if (snapshotCount > 0) {
      console.log(`  [${region}] Found ${snapshotCount} EBS snapshots:`);
      snapshotsResponse.Snapshots?.forEach((s) => {
        const ageMs = s.StartTime ? Date.now() - s.StartTime.getTime() : 0;
        const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
        console.log(
          `    - ${s.SnapshotId}: status=${s.State}, age=${ageDays} days, created=${s.StartTime?.toISOString()}, volumeId=${s.VolumeId}`,
        );
      });
    }

    // Get all existing volume IDs for orphan check
    const volumesCommand = new DescribeVolumesCommand({});
    const volumesResponse = await ec2Client.send(volumesCommand);
    const existingVolumeIds = new Set(
      (volumesResponse.Volumes || []).map((v) => v.VolumeId),
    );

    const now = new Date();
    const ageThresholdMs = SNAPSHOT_AGE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

    for (const snapshot of snapshotsResponse.Snapshots || []) {
      const snapshotId = snapshot.SnapshotId || "";
      const snapshotName =
        snapshot.Tags?.find((t) => t.Key === "Name")?.Value || snapshotId;
      const volumeId = snapshot.VolumeId || "";
      const startTime = snapshot.StartTime;

      // Check if snapshot is orphaned (source volume no longer exists)
      // Note: volumeId might be 'vol-ffffffff' for snapshots from deleted volumes
      const isOrphaned =
        volumeId &&
        volumeId !== "vol-ffffffff" &&
        !existingVolumeIds.has(volumeId);

      // Check if snapshot is old
      const snapshotAgeMs = startTime ? now.getTime() - startTime.getTime() : 0;
      const snapshotAgeDays = Math.floor(snapshotAgeMs / (24 * 60 * 60 * 1000));
      const isOld = snapshotAgeMs > ageThresholdMs;

      if (isOrphaned) {
        unusedResources.push({
          service: "EBS Snapshot",
          resourceId: snapshotId,
          resourceName: snapshotName,
          region,
          cost: 0,
          reason: `Orphaned (volume ${volumeId} deleted)`,
        });
      } else if (isOld) {
        unusedResources.push({
          service: "EBS Snapshot",
          resourceId: snapshotId,
          resourceName: snapshotName,
          region,
          cost: 0,
          reason: `Old snapshot (${snapshotAgeDays} days)`,
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to check EBS snapshots in ${region}:`, error);
  }

  return unusedResources;
}

async function checkRDSSnapshots(region: string, credentials?: AwsCredentials): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const rdsClient = new RDSClient(clientConfig(region, credentials));

  try {
    // Get all RDS snapshots using paginator (recommended AWS SDK v3 pattern)
    const allSnapshots: DBSnapshot[] = [];

    const paginator = paginateDescribeDBSnapshots(
      { client: rdsClient, pageSize: 100 },
      {},
    );

    for await (const page of paginator) {
      if (page.DBSnapshots) {
        allSnapshots.push(...page.DBSnapshots);
      }
    }

    // Get all existing DB instance identifiers for orphan check
    const instancesCommand = new DescribeDBInstancesCommand({});
    const instancesResponse = await rdsClient.send(instancesCommand);
    const existingDbIds = new Set(
      (instancesResponse.DBInstances || []).map((i) => i.DBInstanceIdentifier),
    );

    const now = new Date();
    const ageThresholdMs = SNAPSHOT_AGE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

    for (const snapshot of allSnapshots) {
      if (snapshot.Status !== "available") continue;

      const snapshotId = snapshot.DBSnapshotIdentifier || "";
      const dbInstanceId = snapshot.DBInstanceIdentifier || "";
      const createTime = snapshot.SnapshotCreateTime;
      const snapshotType = snapshot.SnapshotType || "manual";

      // Check if snapshot is orphaned (source DB no longer exists)
      const isOrphaned = dbInstanceId && !existingDbIds.has(dbInstanceId);

      // Check if snapshot is old
      const snapshotAgeMs = createTime
        ? now.getTime() - createTime.getTime()
        : 0;
      const snapshotAgeDays = Math.floor(snapshotAgeMs / (24 * 60 * 60 * 1000));
      const isOld = snapshotAgeMs > ageThresholdMs;

      if (isOrphaned) {
        unusedResources.push({
          service: "RDS Snapshot",
          resourceId: snapshotId,
          resourceName: snapshotId,
          region,
          cost: 0,
          reason: `Orphaned ${snapshotType} snapshot (DB ${dbInstanceId} deleted)`,
        });
      } else if (isOld) {
        unusedResources.push({
          service: "RDS Snapshot",
          resourceId: snapshotId,
          resourceName: snapshotId,
          region,
          cost: 0,
          reason: `Old ${snapshotType} snapshot (${snapshotAgeDays} days)`,
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to check RDS snapshots in ${region}:`, error);
  }

  return unusedResources;
}

async function checkRDSClusterSnapshots(
  region: string,
  credentials?: AwsCredentials,
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const rdsClient = new RDSClient(clientConfig(region, credentials));

  try {
    // Get all Aurora/RDS cluster snapshots using paginator
    const allSnapshots: DBClusterSnapshot[] = [];

    const paginator = paginateDescribeDBClusterSnapshots(
      { client: rdsClient, pageSize: 100 },
      {},
    );

    for await (const page of paginator) {
      if (page.DBClusterSnapshots) {
        allSnapshots.push(...page.DBClusterSnapshots);
      }
    }

    // Get all existing DB cluster identifiers for orphan check
    const clustersCommand = new DescribeDBClustersCommand({});
    const clustersResponse = await rdsClient.send(clustersCommand);
    const existingClusterIds = new Set(
      (clustersResponse.DBClusters || []).map((c) => c.DBClusterIdentifier),
    );

    const now = new Date();
    const ageThresholdMs = SNAPSHOT_AGE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

    for (const snapshot of allSnapshots) {
      if (snapshot.Status !== "available") continue;

      const snapshotId = snapshot.DBClusterSnapshotIdentifier || "";
      const clusterId = snapshot.DBClusterIdentifier || "";
      const createTime = snapshot.SnapshotCreateTime;
      const snapshotType = snapshot.SnapshotType || "manual";

      // Check if snapshot is orphaned (source cluster no longer exists)
      const isOrphaned = clusterId && !existingClusterIds.has(clusterId);

      // Check if snapshot is old
      const snapshotAgeMs = createTime
        ? now.getTime() - createTime.getTime()
        : 0;
      const snapshotAgeDays = Math.floor(snapshotAgeMs / (24 * 60 * 60 * 1000));
      const isOld = snapshotAgeMs > ageThresholdMs;

      if (isOrphaned) {
        unusedResources.push({
          service: "RDS Cluster Snapshot",
          resourceId: snapshotId,
          resourceName: snapshotId,
          region,
          cost: 0,
          reason: `Orphaned ${snapshotType} snapshot (cluster ${clusterId} deleted)`,
        });
      } else if (isOld) {
        unusedResources.push({
          service: "RDS Cluster Snapshot",
          resourceId: snapshotId,
          resourceName: snapshotId,
          region,
          cost: 0,
          reason: `Old ${snapshotType} snapshot (${snapshotAgeDays} days)`,
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to check RDS cluster snapshots in ${region}:`, error);
  }

  return unusedResources;
}

async function checkEFSBackups(region: string, credentials?: AwsCredentials): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const backupClient = new BackupClient(clientConfig(region, credentials));
  const efsClient = new EFSClient(clientConfig(region, credentials));

  try {
    // Get all existing EFS file system IDs for orphan check
    const efsCommand = new DescribeFileSystemsCommand({});
    const efsResponse = await efsClient.send(efsCommand);
    const existingEfsIds = new Set(
      (efsResponse.FileSystems || []).map((fs) => fs.FileSystemId),
    );

    // List all backup vaults
    const vaultsCommand = new ListBackupVaultsCommand({});
    const vaultsResponse = await backupClient.send(vaultsCommand);

    const now = new Date();
    const ageThresholdMs = SNAPSHOT_AGE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

    for (const vault of vaultsResponse.BackupVaultList || []) {
      const vaultName = vault.BackupVaultName || "";

      // List recovery points in this vault
      const recoveryPointsCommand = new ListRecoveryPointsByBackupVaultCommand({
        BackupVaultName: vaultName,
        ByResourceType: "EFS",
      });
      const recoveryPointsResponse = await backupClient.send(
        recoveryPointsCommand,
      );

      for (const rp of recoveryPointsResponse.RecoveryPoints || []) {
        if (rp.Status !== "COMPLETED") continue;

        const recoveryPointArn = rp.RecoveryPointArn || "";
        const resourceArn = rp.ResourceArn || "";
        const creationDate = rp.CreationDate;

        // Extract EFS file system ID from resource ARN
        // ARN format: arn:aws:elasticfilesystem:region:account:file-system/fs-xxxxxxxx
        const efsIdMatch = resourceArn.match(/file-system\/(fs-[a-z0-9]+)/);
        const efsId = efsIdMatch ? efsIdMatch[1] : "";

        // Check if backup is orphaned (source EFS no longer exists)
        const isOrphaned = efsId && !existingEfsIds.has(efsId);

        // Check if backup is old
        const backupAgeMs = creationDate
          ? now.getTime() - creationDate.getTime()
          : 0;
        const backupAgeDays = Math.floor(backupAgeMs / (24 * 60 * 60 * 1000));
        const isOld = backupAgeMs > ageThresholdMs;

        // Create a shorter display name from the ARN
        const shortId = recoveryPointArn.split(":").pop() || recoveryPointArn;

        if (isOrphaned) {
          unusedResources.push({
            service: "EFS Backup",
            resourceId: shortId,
            resourceName: `Backup of ${efsId}`,
            region,
            cost: 0,
            reason: `Orphaned (EFS ${efsId} deleted)`,
          });
        } else if (isOld) {
          unusedResources.push({
            service: "EFS Backup",
            resourceId: shortId,
            resourceName: `Backup of ${efsId || "unknown"}`,
            region,
            cost: 0,
            reason: `Old backup (${backupAgeDays} days)`,
          });
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to check EFS backups in ${region}:`, error);
  }

  return unusedResources;
}

async function checkRDSInstances(
  region: string,
  dateRange: DateRange,
  credentials?: AwsCredentials,
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const rdsClient = new RDSClient(clientConfig(region, credentials));
  const cwClient = new CloudWatchClient(clientConfig(region, credentials));

  try {
    const command = new DescribeDBInstancesCommand({});
    const response = await rdsClient.send(command);

    for (const instance of response.DBInstances || []) {
      if (instance.DBInstanceStatus !== "available") continue;

      const instanceId = instance.DBInstanceIdentifier || "";

      const connections = await getCloudWatchMetric(
        cwClient,
        "AWS/RDS",
        "DatabaseConnections",
        [{ Name: "DBInstanceIdentifier", Value: instanceId }],
        dateRange,
      );

      if (connections >= 0 && connections < CONNECTIONS_THRESHOLD) {
        unusedResources.push({
          service: "Amazon RDS",
          resourceId: instanceId,
          resourceName: instanceId,
          region,
          cost: 0,
          reason: `No connections (${connections.toFixed(0)} avg)`,
        });
        continue;
      }

      const cpuAvg = await getCloudWatchMetric(
        cwClient,
        "AWS/RDS",
        "CPUUtilization",
        [{ Name: "DBInstanceIdentifier", Value: instanceId }],
        dateRange,
      );

      if (cpuAvg >= 0 && cpuAvg < CPU_THRESHOLD) {
        unusedResources.push({
          service: "Amazon RDS",
          resourceId: instanceId,
          resourceName: instanceId,
          region,
          cost: 0,
          reason: `Low CPU (${cpuAvg.toFixed(1)}% avg)`,
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to check RDS instances in ${region}:`, error);
  }

  return unusedResources;
}

async function checkLoadBalancers(
  region: string,
  dateRange: DateRange,
  credentials?: AwsCredentials,
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const elbClient = new ElasticLoadBalancingV2Client(clientConfig(region, credentials));
  const cwClient = new CloudWatchClient(clientConfig(region, credentials));

  try {
    const command = new DescribeLoadBalancersCommand({});
    const response = await elbClient.send(command);

    for (const lb of response.LoadBalancers || []) {
      const lbArn = lb.LoadBalancerArn || "";
      const lbName = lb.LoadBalancerName || "";
      const arnParts = lbArn.split("/");
      const lbDimension = arnParts.slice(-3).join("/");

      const namespace =
        lb.Type === "network" ? "AWS/NetworkELB" : "AWS/ApplicationELB";
      const metricName =
        lb.Type === "network" ? "ActiveFlowCount" : "RequestCount";

      const requestCount = await getCloudWatchSumMetric(
        cwClient,
        namespace,
        metricName,
        [{ Name: "LoadBalancer", Value: lbDimension }],
        dateRange,
      );

      if (requestCount >= 0 && requestCount === 0) {
        unusedResources.push({
          service: "Elastic Load Balancing",
          resourceId: lbArn,
          resourceName: lbName,
          region,
          cost: 0,
          reason: "No traffic",
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to check load balancers in ${region}:`, error);
  }

  return unusedResources;
}

async function checkElasticIPs(region: string, credentials?: AwsCredentials): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const ec2Client = new EC2Client(clientConfig(region, credentials));

  try {
    const command = new DescribeAddressesCommand({});
    const response = await ec2Client.send(command);

    for (const address of response.Addresses || []) {
      // Elastic IPs not associated with any instance or network interface
      if (!address.InstanceId && !address.NetworkInterfaceId) {
        unusedResources.push({
          service: "Amazon EC2 (EIP)",
          resourceId: address.AllocationId || address.PublicIp || "",
          resourceName: address.PublicIp || "",
          region,
          cost: 0,
          reason: "Unattached Elastic IP",
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to check Elastic IPs in ${region}:`, error);
  }

  return unusedResources;
}

async function checkNATGateways(
  region: string,
  dateRange: DateRange,
  credentials?: AwsCredentials,
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const ec2Client = new EC2Client(clientConfig(region, credentials));
  const cwClient = new CloudWatchClient(clientConfig(region, credentials));

  try {
    const command = new DescribeNatGatewaysCommand({
      Filter: [{ Name: "state", Values: ["available"] }],
    });
    const response = await ec2Client.send(command);

    for (const natGw of response.NatGateways || []) {
      const natGwId = natGw.NatGatewayId || "";
      const natGwName =
        natGw.Tags?.find((t) => t.Key === "Name")?.Value || natGwId;

      const bytesOut = await getCloudWatchSumMetric(
        cwClient,
        "AWS/NATGateway",
        "BytesOutToDestination",
        [{ Name: "NatGatewayId", Value: natGwId }],
        dateRange,
      );

      if (bytesOut >= 0 && bytesOut === 0) {
        unusedResources.push({
          service: "NAT Gateway",
          resourceId: natGwId,
          resourceName: natGwName,
          region,
          cost: 0,
          reason: "No outbound traffic",
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to check NAT Gateways in ${region}:`, error);
  }

  return unusedResources;
}

async function checkEFSFileSystems(
  region: string,
  dateRange: DateRange,
  credentials?: AwsCredentials,
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const efsClient = new EFSClient(clientConfig(region, credentials));
  const cwClient = new CloudWatchClient(clientConfig(region, credentials));

  try {
    const command = new DescribeFileSystemsCommand({});
    const response = await efsClient.send(command);

    for (const fs of response.FileSystems || []) {
      const fsId = fs.FileSystemId || "";
      const fsName = fs.Name || fsId;

      const connections = await getCloudWatchMetric(
        cwClient,
        "AWS/EFS",
        "ClientConnections",
        [{ Name: "FileSystemId", Value: fsId }],
        dateRange,
      );

      if (connections >= 0 && connections === 0) {
        unusedResources.push({
          service: "Amazon EFS",
          resourceId: fsId,
          resourceName: fsName,
          region,
          cost: 0,
          reason: "No client connections",
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to check EFS file systems in ${region}:`, error);
  }

  return unusedResources;
}

async function checkEKSClusters(
  region: string,
  dateRange: DateRange,
  credentials?: AwsCredentials,
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const eksClient = new EKSClient(clientConfig(region, credentials));
  const cwClient = new CloudWatchClient(clientConfig(region, credentials));

  try {
    const listCommand = new ListClustersCommand({});
    const listResponse = await eksClient.send(listCommand);

    for (const clusterName of listResponse.clusters || []) {
      const describeCommand = new DescribeClusterCommand({ name: clusterName });
      const cluster = await eksClient.send(describeCommand);

      if (cluster.cluster?.status !== "ACTIVE") continue;

      // Check for node count via CloudWatch
      const nodeCount = await getCloudWatchMetric(
        cwClient,
        "ContainerInsights",
        "cluster_node_count",
        [{ Name: "ClusterName", Value: clusterName }],
        dateRange,
      );

      if (nodeCount >= 0 && nodeCount === 0) {
        unusedResources.push({
          service: "Amazon EKS",
          resourceId: cluster.cluster?.arn || clusterName,
          resourceName: clusterName,
          region,
          cost: 0,
          reason: "No nodes in cluster",
        });
        continue;
      }

      // Check CPU utilization if Container Insights is enabled
      const cpuAvg = await getCloudWatchMetric(
        cwClient,
        "ContainerInsights",
        "cluster_cpu_utilization",
        [{ Name: "ClusterName", Value: clusterName }],
        dateRange,
      );

      if (cpuAvg >= 0 && cpuAvg < CPU_THRESHOLD) {
        unusedResources.push({
          service: "Amazon EKS",
          resourceId: cluster.cluster?.arn || clusterName,
          resourceName: clusterName,
          region,
          cost: 0,
          reason: `Low CPU (${cpuAvg.toFixed(1)}% avg)`,
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to check EKS clusters in ${region}:`, error);
  }

  return unusedResources;
}

async function checkECSClusters(
  region: string,
  dateRange: DateRange,
  credentials?: AwsCredentials,
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const ecsClient = new ECSClient(clientConfig(region, credentials));
  const cwClient = new CloudWatchClient(clientConfig(region, credentials));

  try {
    const listCommand = new ECSListClustersCommand({});
    const listResponse = await ecsClient.send(listCommand);

    for (const clusterArn of listResponse.clusterArns || []) {
      const clusterName = clusterArn.split("/").pop() || "";

      // List services in the cluster
      const servicesCommand = new ListServicesCommand({ cluster: clusterArn });
      const servicesResponse = await ecsClient.send(servicesCommand);

      if (
        !servicesResponse.serviceArns ||
        servicesResponse.serviceArns.length === 0
      ) {
        unusedResources.push({
          service: "Amazon ECS",
          resourceId: clusterArn,
          resourceName: clusterName,
          region,
          cost: 0,
          reason: "No services in cluster",
        });
        continue;
      }

      // Check each service for running tasks
      const describeServicesCommand = new DescribeServicesCommand({
        cluster: clusterArn,
        services: servicesResponse.serviceArns.slice(0, 10), // Max 10 at a time
      });
      const describeResponse = await ecsClient.send(describeServicesCommand);

      for (const service of describeResponse.services || []) {
        if (service.runningCount === 0 && service.desiredCount === 0) {
          unusedResources.push({
            service: "Amazon ECS",
            resourceId: service.serviceArn || "",
            resourceName: service.serviceName || "",
            region,
            cost: 0,
            reason: "No running tasks",
          });
        } else if (service.runningCount && service.runningCount > 0) {
          // Check CPU utilization for running services
          const cpuAvg = await getCloudWatchMetric(
            cwClient,
            "AWS/ECS",
            "CPUUtilization",
            [
              { Name: "ClusterName", Value: clusterName },
              { Name: "ServiceName", Value: service.serviceName || "" },
            ],
            dateRange,
          );

          if (cpuAvg >= 0 && cpuAvg < CPU_THRESHOLD) {
            unusedResources.push({
              service: "Amazon ECS",
              resourceId: service.serviceArn || "",
              resourceName: service.serviceName || "",
              region,
              cost: 0,
              reason: `Low CPU (${cpuAvg.toFixed(1)}% avg)`,
            });
          }
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to check ECS clusters in ${region}:`, error);
  }

  return unusedResources;
}

async function checkElastiCacheClusters(
  region: string,
  dateRange: DateRange,
  credentials?: AwsCredentials,
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const elasticacheClient = new ElastiCacheClient(clientConfig(region, credentials));
  const cwClient = new CloudWatchClient(clientConfig(region, credentials));

  try {
    const command = new DescribeCacheClustersCommand({});
    const response = await elasticacheClient.send(command);

    for (const cluster of response.CacheClusters || []) {
      if (cluster.CacheClusterStatus !== "available") continue;

      const clusterId = cluster.CacheClusterId || "";

      // Check current connections
      const connections = await getCloudWatchMetric(
        cwClient,
        "AWS/ElastiCache",
        "CurrConnections",
        [{ Name: "CacheClusterId", Value: clusterId }],
        dateRange,
      );

      if (connections >= 0 && connections < CONNECTIONS_THRESHOLD) {
        unusedResources.push({
          service: "Amazon ElastiCache",
          resourceId: clusterId,
          resourceName: clusterId,
          region,
          cost: 0,
          reason: `No connections (${connections.toFixed(0)} avg)`,
        });
        continue;
      }

      // Check CPU utilization
      const cpuAvg = await getCloudWatchMetric(
        cwClient,
        "AWS/ElastiCache",
        "CPUUtilization",
        [{ Name: "CacheClusterId", Value: clusterId }],
        dateRange,
      );

      if (cpuAvg >= 0 && cpuAvg < CPU_THRESHOLD) {
        unusedResources.push({
          service: "Amazon ElastiCache",
          resourceId: clusterId,
          resourceName: clusterId,
          region,
          cost: 0,
          reason: `Low CPU (${cpuAvg.toFixed(1)}% avg)`,
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to check ElastiCache clusters in ${region}:`, error);
  }

  return unusedResources;
}

async function checkRedshiftClusters(
  region: string,
  dateRange: DateRange,
  credentials?: AwsCredentials,
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const redshiftClient = new RedshiftClient(clientConfig(region, credentials));
  const cwClient = new CloudWatchClient(clientConfig(region, credentials));

  try {
    const command = new RedshiftDescribeClustersCommand({});
    const response = await redshiftClient.send(command);

    for (const cluster of response.Clusters || []) {
      if (cluster.ClusterStatus !== "available") continue;

      const clusterId = cluster.ClusterIdentifier || "";

      // Check database connections
      const connections = await getCloudWatchMetric(
        cwClient,
        "AWS/Redshift",
        "DatabaseConnections",
        [{ Name: "ClusterIdentifier", Value: clusterId }],
        dateRange,
      );

      if (connections >= 0 && connections < CONNECTIONS_THRESHOLD) {
        unusedResources.push({
          service: "Amazon Redshift",
          resourceId: clusterId,
          resourceName: clusterId,
          region,
          cost: 0,
          reason: `No connections (${connections.toFixed(0)} avg)`,
        });
        continue;
      }

      // Check CPU utilization
      const cpuAvg = await getCloudWatchMetric(
        cwClient,
        "AWS/Redshift",
        "CPUUtilization",
        [{ Name: "ClusterIdentifier", Value: clusterId }],
        dateRange,
      );

      if (cpuAvg >= 0 && cpuAvg < CPU_THRESHOLD) {
        unusedResources.push({
          service: "Amazon Redshift",
          resourceId: clusterId,
          resourceName: clusterId,
          region,
          cost: 0,
          reason: `Low CPU (${cpuAvg.toFixed(1)}% avg)`,
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to check Redshift clusters in ${region}:`, error);
  }

  return unusedResources;
}

async function checkOpenSearchDomains(
  region: string,
  dateRange: DateRange,
  credentials?: AwsCredentials,
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const opensearchClient = new OpenSearchClient(clientConfig(region, credentials));
  const cwClient = new CloudWatchClient(clientConfig(region, credentials));

  try {
    const listCommand = new ListDomainNamesCommand({});
    const listResponse = await opensearchClient.send(listCommand);

    for (const domain of listResponse.DomainNames || []) {
      const domainName = domain.DomainName || "";

      const describeCommand = new DescribeDomainCommand({
        DomainName: domainName,
      });
      const domainInfo = await opensearchClient.send(describeCommand);

      if (!domainInfo.DomainStatus?.Created) continue;

      // Check search requests
      const searchRate = await getCloudWatchSumMetric(
        cwClient,
        "AWS/ES",
        "SearchRate",
        [
          { Name: "DomainName", Value: domainName },
          {
            Name: "ClientId",
            Value: domainInfo.DomainStatus?.DomainId?.split("/")[0] || "",
          },
        ],
        dateRange,
      );

      if (searchRate >= 0 && searchRate === 0) {
        unusedResources.push({
          service: "Amazon OpenSearch",
          resourceId: domainInfo.DomainStatus?.ARN || domainName,
          resourceName: domainName,
          region,
          cost: 0,
          reason: "No search requests",
        });
        continue;
      }

      // Check CPU utilization
      const cpuAvg = await getCloudWatchMetric(
        cwClient,
        "AWS/ES",
        "CPUUtilization",
        [
          { Name: "DomainName", Value: domainName },
          {
            Name: "ClientId",
            Value: domainInfo.DomainStatus?.DomainId?.split("/")[0] || "",
          },
        ],
        dateRange,
      );

      if (cpuAvg >= 0 && cpuAvg < CPU_THRESHOLD) {
        unusedResources.push({
          service: "Amazon OpenSearch",
          resourceId: domainInfo.DomainStatus?.ARN || domainName,
          resourceName: domainName,
          region,
          cost: 0,
          reason: `Low CPU (${cpuAvg.toFixed(1)}% avg)`,
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to check OpenSearch domains in ${region}:`, error);
  }

  return unusedResources;
}

// Scan all regions for unused resources in a single account
async function scanAccountRegions(
  dateRange: DateRange,
  accountId: string,
  accountName: string,
  credentials?: AwsCredentials,
): Promise<{ resources: UnusedResource[]; errors: number }> {
  const resources: UnusedResource[] = [];
  let errors = 0;

  const batchSize = 4;
  for (let i = 0; i < AWS_REGIONS.length; i += batchSize) {
    const batch = AWS_REGIONS.slice(i, i + batchSize);
    console.log(
      `  [${accountName}] Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(AWS_REGIONS.length / batchSize)}: ${batch.join(", ")}`,
    );

    const batchResults = await Promise.all(
      batch.map(async (region) => {
        const results: UnusedResource[] = [];

        try {
          const [
            ec2Results,
            ebsResults,
            ebsSnapshotResults,
            rdsResults,
            rdsSnapshotResults,
            rdsClusterSnapshotResults,
            elbResults,
            eipResults,
            natResults,
            efsResults,
            efsBackupResults,
            eksResults,
            ecsResults,
            elasticacheResults,
            redshiftResults,
            opensearchResults,
          ] = await Promise.all([
            checkEC2Instances(region, dateRange, credentials),
            checkEBSVolumes(region, dateRange, credentials),
            checkEBSSnapshots(region, credentials),
            checkRDSInstances(region, dateRange, credentials),
            checkRDSSnapshots(region, credentials),
            checkRDSClusterSnapshots(region, credentials),
            checkLoadBalancers(region, dateRange, credentials),
            checkElasticIPs(region, credentials),
            checkNATGateways(region, dateRange, credentials),
            checkEFSFileSystems(region, dateRange, credentials),
            checkEFSBackups(region, credentials),
            checkEKSClusters(region, dateRange, credentials),
            checkECSClusters(region, dateRange, credentials),
            checkElastiCacheClusters(region, dateRange, credentials),
            checkRedshiftClusters(region, dateRange, credentials),
            checkOpenSearchDomains(region, dateRange, credentials),
          ]);

          results.push(
            ...ec2Results,
            ...ebsResults,
            ...ebsSnapshotResults,
            ...rdsResults,
            ...rdsSnapshotResults,
            ...rdsClusterSnapshotResults,
            ...elbResults,
            ...eipResults,
            ...natResults,
            ...efsResults,
            ...efsBackupResults,
            ...eksResults,
            ...ecsResults,
            ...elasticacheResults,
            ...redshiftResults,
            ...opensearchResults,
          );

          if (results.length > 0) {
            console.log(
              `    [${accountName}/${region}] Found ${results.length} unused resource(s)`,
            );
            results.forEach((r) => {
              console.log(
                `      - ${r.service}: ${r.resourceName || r.resourceId} (${r.reason})`,
              );
            });
          }
        } catch (error) {
          console.error(`    [${accountName}/${region}] ERROR: ${(error as Error).message}`);
          errors++;
        }

        return results;
      }),
    );

    resources.push(...batchResults.flat());
  }

  // Tag all resources with account info
  for (const r of resources) {
    r.accountId = accountId;
    r.accountName = accountName;
  }

  return { resources, errors };
}

export async function detectUnusedResources(
  dateRange: DateRange,
): Promise<UnusedResource[]> {
  console.log("=== Starting Unused Resources Detection ===");

  const parentAccountId = await getAccountId();
  console.log(`Parent Account ID: ${parentAccountId}`);
  console.log(`Date range: ${dateRange.start} to ${dateRange.end}`);
  console.log(`Regions to check: ${AWS_REGIONS.length}`);
  console.log(
    `Thresholds - CPU: ${CPU_THRESHOLD}%, Network: ${NETWORK_THRESHOLD} bytes, Connections: ${CONNECTIONS_THRESHOLD}`,
  );
  console.log(`Snapshot age threshold: ${SNAPSHOT_AGE_THRESHOLD_DAYS} days`);

  const allUnusedResources: UnusedResource[] = [];
  let totalErrors = 0;

  // Determine if we should scan across configured child accounts
  const useOrgMode = shouldUseOrganizationMode();

  if (useOrgMode) {
    const orgAccounts = getConfiguredAccounts();

    if (orgAccounts && orgAccounts.size > 0) {
      console.log(`Organization mode: scanning ${orgAccounts.size} account(s)`);
      console.log(`Cross-account role: ${CROSS_ACCOUNT_ROLE_NAME}`);

      // Process accounts sequentially to avoid STS throttling
      for (const [acctId, acctInfo] of orgAccounts) {
        console.log(`\n--- Scanning account: ${acctInfo.name} (${acctId}) ---`);

        let credentials: AwsCredentials | undefined;

        if (acctId === parentAccountId) {
          // Parent account: use default Lambda credentials
          console.log(`  Using default credentials (parent account)`);
        } else {
          // Child account: assume cross-account role
          const assumed = await assumeRole(acctId);
          if (!assumed) {
            console.warn(`  Skipping account ${acctInfo.name} (${acctId}) - AssumeRole failed`);
            totalErrors++;
            continue;
          }
          credentials = assumed;
          console.log(`  Assumed role ${CROSS_ACCOUNT_ROLE_NAME} successfully`);
        }

        const { resources, errors } = await scanAccountRegions(
          dateRange,
          acctId,
          acctInfo.name,
          credentials,
        );

        allUnusedResources.push(...resources);
        totalErrors += errors;
        console.log(`  Account ${acctInfo.name}: found ${resources.length} unused resource(s), ${errors} error(s)`);
      }
    } else {
      // Fallback to single-account scan
      console.log("Organization mode enabled but no accounts found - scanning current account only");
      const { resources, errors } = await scanAccountRegions(
        dateRange,
        parentAccountId,
        parentAccountId,
      );
      allUnusedResources.push(...resources);
      totalErrors += errors;
    }
  } else {
    // Single account mode
    console.log("Single account mode: scanning current account only");
    const { resources, errors } = await scanAccountRegions(
      dateRange,
      parentAccountId,
      parentAccountId,
    );
    allUnusedResources.push(...resources);
    totalErrors += errors;
  }

  // Summary logging
  console.log("\n=== Unused Resources Detection Summary ===");
  console.log(`Organization mode: ${useOrgMode}`);
  console.log(`Total regions checked per account: ${AWS_REGIONS.length}`);
  console.log(`Total errors encountered: ${totalErrors}`);
  console.log(`Total unused resources found: ${allUnusedResources.length}`);

  if (allUnusedResources.length > 0) {
    // Group by account for summary
    if (useOrgMode) {
      const byAccount: Record<string, number> = {};
      allUnusedResources.forEach((r) => {
        const key = r.accountName || r.accountId || "unknown";
        byAccount[key] = (byAccount[key] || 0) + 1;
      });
      console.log("Breakdown by account:");
      Object.entries(byAccount)
        .sort((a, b) => b[1] - a[1])
        .forEach(([account, count]) => {
          console.log(`  - ${account}: ${count}`);
        });
    }

    // Group by service type for summary
    const byService: Record<string, number> = {};
    allUnusedResources.forEach((r) => {
      byService[r.service] = (byService[r.service] || 0) + 1;
    });
    console.log("Breakdown by service:");
    Object.entries(byService)
      .sort((a, b) => b[1] - a[1])
      .forEach(([service, count]) => {
        console.log(`  - ${service}: ${count}`);
      });
  }

  return allUnusedResources;
}
