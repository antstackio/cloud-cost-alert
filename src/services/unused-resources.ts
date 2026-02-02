import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DescribeAddressesCommand,
  DescribeNatGatewaysCommand,
} from '@aws-sdk/client-ec2';
import {
  RDSClient,
  DescribeDBInstancesCommand,
} from '@aws-sdk/client-rds';
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  EFSClient,
  DescribeFileSystemsCommand,
} from '@aws-sdk/client-efs';
import {
  EKSClient,
  ListClustersCommand,
  DescribeClusterCommand,
} from '@aws-sdk/client-eks';
import {
  ECSClient,
  ListClustersCommand as ECSListClustersCommand,
  ListServicesCommand,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs';
import {
  ElastiCacheClient,
  DescribeCacheClustersCommand,
} from '@aws-sdk/client-elasticache';
import {
  RedshiftClient,
  DescribeClustersCommand as RedshiftDescribeClustersCommand,
} from '@aws-sdk/client-redshift';
import {
  OpenSearchClient,
  ListDomainNamesCommand,
  DescribeDomainCommand,
} from '@aws-sdk/client-opensearch';
import { UnusedResource, DateRange } from '../types';

// All AWS regions to check
const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'ap-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-southeast-1', 'ap-southeast-2',
  'ca-central-1',
  'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1',
  'sa-east-1',
  'me-south-1',
  'af-south-1',
];

// Thresholds for determining unused resources
const CPU_THRESHOLD = 5; // Average CPU below 5% is considered idle
const NETWORK_THRESHOLD = 1000; // Less than 1KB/s is considered idle
const CONNECTIONS_THRESHOLD = 1; // Less than 1 connection is considered idle

async function getCloudWatchMetric(
  client: CloudWatchClient,
  namespace: string,
  metricName: string,
  dimensions: { Name: string; Value: string }[],
  dateRange: DateRange
): Promise<number> {
  try {
    const command = new GetMetricStatisticsCommand({
      Namespace: namespace,
      MetricName: metricName,
      Dimensions: dimensions,
      StartTime: new Date(dateRange.start),
      EndTime: new Date(dateRange.end),
      Period: 86400, // 1 day
      Statistics: ['Average'],
    });

    const response = await client.send(command);
    if (response.Datapoints && response.Datapoints.length > 0) {
      const sum = response.Datapoints.reduce((acc, dp) => acc + (dp.Average || 0), 0);
      return sum / response.Datapoints.length;
    }
    return 0;
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
  dateRange: DateRange
): Promise<number> {
  try {
    const command = new GetMetricStatisticsCommand({
      Namespace: namespace,
      MetricName: metricName,
      Dimensions: dimensions,
      StartTime: new Date(dateRange.start),
      EndTime: new Date(dateRange.end),
      Period: 86400,
      Statistics: ['Sum'],
    });

    const response = await client.send(command);
    if (response.Datapoints && response.Datapoints.length > 0) {
      return response.Datapoints.reduce((acc, dp) => acc + (dp.Sum || 0), 0);
    }
    return 0;
  } catch (error) {
    console.warn(`Failed to get CloudWatch sum metric ${metricName}:`, error);
    return -1;
  }
}

async function checkEC2Instances(
  region: string,
  dateRange: DateRange
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const ec2Client = new EC2Client({ region });
  const cwClient = new CloudWatchClient({ region });

  try {
    const command = new DescribeInstancesCommand({
      Filters: [{ Name: 'instance-state-name', Values: ['running'] }],
    });
    const response = await ec2Client.send(command);

    for (const reservation of response.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        const instanceId = instance.InstanceId || '';
        const instanceName = instance.Tags?.find(t => t.Key === 'Name')?.Value || instanceId;

        const cpuAvg = await getCloudWatchMetric(
          cwClient, 'AWS/EC2', 'CPUUtilization',
          [{ Name: 'InstanceId', Value: instanceId }],
          dateRange
        );

        if (cpuAvg >= 0 && cpuAvg < CPU_THRESHOLD) {
          unusedResources.push({
            service: 'Amazon EC2',
            resourceId: instanceId,
            resourceName: instanceName,
            region,
            cost: 0,
            reason: `Low CPU (${cpuAvg.toFixed(1)}% avg)`,
          });
          continue;
        }

        const networkIn = await getCloudWatchMetric(
          cwClient, 'AWS/EC2', 'NetworkIn',
          [{ Name: 'InstanceId', Value: instanceId }],
          dateRange
        );
        const networkOut = await getCloudWatchMetric(
          cwClient, 'AWS/EC2', 'NetworkOut',
          [{ Name: 'InstanceId', Value: instanceId }],
          dateRange
        );

        if (networkIn >= 0 && networkOut >= 0 &&
            networkIn < NETWORK_THRESHOLD && networkOut < NETWORK_THRESHOLD) {
          unusedResources.push({
            service: 'Amazon EC2',
            resourceId: instanceId,
            resourceName: instanceName,
            region,
            cost: 0,
            reason: 'No network traffic',
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
  dateRange: DateRange
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const ec2Client = new EC2Client({ region });
  const cwClient = new CloudWatchClient({ region });

  try {
    const command = new DescribeVolumesCommand({});
    const response = await ec2Client.send(command);

    for (const volume of response.Volumes || []) {
      const volumeId = volume.VolumeId || '';
      const volumeName = volume.Tags?.find(t => t.Key === 'Name')?.Value || volumeId;

      if (!volume.Attachments || volume.Attachments.length === 0) {
        unusedResources.push({
          service: 'Amazon EBS',
          resourceId: volumeId,
          resourceName: volumeName,
          region,
          cost: 0,
          reason: 'Unattached volume',
        });
        continue;
      }

      const readOps = await getCloudWatchMetric(
        cwClient, 'AWS/EBS', 'VolumeReadOps',
        [{ Name: 'VolumeId', Value: volumeId }],
        dateRange
      );
      const writeOps = await getCloudWatchMetric(
        cwClient, 'AWS/EBS', 'VolumeWriteOps',
        [{ Name: 'VolumeId', Value: volumeId }],
        dateRange
      );

      if (readOps >= 0 && writeOps >= 0 && readOps === 0 && writeOps === 0) {
        unusedResources.push({
          service: 'Amazon EBS',
          resourceId: volumeId,
          resourceName: volumeName,
          region,
          cost: 0,
          reason: 'No I/O operations',
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to check EBS volumes in ${region}:`, error);
  }

  return unusedResources;
}

async function checkRDSInstances(
  region: string,
  dateRange: DateRange
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const rdsClient = new RDSClient({ region });
  const cwClient = new CloudWatchClient({ region });

  try {
    const command = new DescribeDBInstancesCommand({});
    const response = await rdsClient.send(command);

    for (const instance of response.DBInstances || []) {
      if (instance.DBInstanceStatus !== 'available') continue;

      const instanceId = instance.DBInstanceIdentifier || '';

      const connections = await getCloudWatchMetric(
        cwClient, 'AWS/RDS', 'DatabaseConnections',
        [{ Name: 'DBInstanceIdentifier', Value: instanceId }],
        dateRange
      );

      if (connections >= 0 && connections < CONNECTIONS_THRESHOLD) {
        unusedResources.push({
          service: 'Amazon RDS',
          resourceId: instanceId,
          resourceName: instanceId,
          region,
          cost: 0,
          reason: `No connections (${connections.toFixed(0)} avg)`,
        });
        continue;
      }

      const cpuAvg = await getCloudWatchMetric(
        cwClient, 'AWS/RDS', 'CPUUtilization',
        [{ Name: 'DBInstanceIdentifier', Value: instanceId }],
        dateRange
      );

      if (cpuAvg >= 0 && cpuAvg < CPU_THRESHOLD) {
        unusedResources.push({
          service: 'Amazon RDS',
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
  dateRange: DateRange
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const elbClient = new ElasticLoadBalancingV2Client({ region });
  const cwClient = new CloudWatchClient({ region });

  try {
    const command = new DescribeLoadBalancersCommand({});
    const response = await elbClient.send(command);

    for (const lb of response.LoadBalancers || []) {
      const lbArn = lb.LoadBalancerArn || '';
      const lbName = lb.LoadBalancerName || '';
      const arnParts = lbArn.split('/');
      const lbDimension = arnParts.slice(-3).join('/');

      const namespace = lb.Type === 'network' ? 'AWS/NetworkELB' : 'AWS/ApplicationELB';
      const metricName = lb.Type === 'network' ? 'ActiveFlowCount' : 'RequestCount';

      const requestCount = await getCloudWatchSumMetric(
        cwClient, namespace, metricName,
        [{ Name: 'LoadBalancer', Value: lbDimension }],
        dateRange
      );

      if (requestCount >= 0 && requestCount === 0) {
        unusedResources.push({
          service: 'Elastic Load Balancing',
          resourceId: lbArn,
          resourceName: lbName,
          region,
          cost: 0,
          reason: 'No traffic',
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to check load balancers in ${region}:`, error);
  }

  return unusedResources;
}

async function checkElasticIPs(
  region: string
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const ec2Client = new EC2Client({ region });

  try {
    const command = new DescribeAddressesCommand({});
    const response = await ec2Client.send(command);

    for (const address of response.Addresses || []) {
      // Elastic IPs not associated with any instance or network interface
      if (!address.InstanceId && !address.NetworkInterfaceId) {
        unusedResources.push({
          service: 'Amazon EC2 (EIP)',
          resourceId: address.AllocationId || address.PublicIp || '',
          resourceName: address.PublicIp || '',
          region,
          cost: 0,
          reason: 'Unattached Elastic IP',
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
  dateRange: DateRange
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const ec2Client = new EC2Client({ region });
  const cwClient = new CloudWatchClient({ region });

  try {
    const command = new DescribeNatGatewaysCommand({
      Filter: [{ Name: 'state', Values: ['available'] }],
    });
    const response = await ec2Client.send(command);

    for (const natGw of response.NatGateways || []) {
      const natGwId = natGw.NatGatewayId || '';
      const natGwName = natGw.Tags?.find(t => t.Key === 'Name')?.Value || natGwId;

      const bytesOut = await getCloudWatchSumMetric(
        cwClient, 'AWS/NATGateway', 'BytesOutToDestination',
        [{ Name: 'NatGatewayId', Value: natGwId }],
        dateRange
      );

      if (bytesOut >= 0 && bytesOut === 0) {
        unusedResources.push({
          service: 'NAT Gateway',
          resourceId: natGwId,
          resourceName: natGwName,
          region,
          cost: 0,
          reason: 'No outbound traffic',
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
  dateRange: DateRange
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const efsClient = new EFSClient({ region });
  const cwClient = new CloudWatchClient({ region });

  try {
    const command = new DescribeFileSystemsCommand({});
    const response = await efsClient.send(command);

    for (const fs of response.FileSystems || []) {
      const fsId = fs.FileSystemId || '';
      const fsName = fs.Name || fsId;

      const connections = await getCloudWatchMetric(
        cwClient, 'AWS/EFS', 'ClientConnections',
        [{ Name: 'FileSystemId', Value: fsId }],
        dateRange
      );

      if (connections >= 0 && connections === 0) {
        unusedResources.push({
          service: 'Amazon EFS',
          resourceId: fsId,
          resourceName: fsName,
          region,
          cost: 0,
          reason: 'No client connections',
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
  dateRange: DateRange
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const eksClient = new EKSClient({ region });
  const cwClient = new CloudWatchClient({ region });

  try {
    const listCommand = new ListClustersCommand({});
    const listResponse = await eksClient.send(listCommand);

    for (const clusterName of listResponse.clusters || []) {
      const describeCommand = new DescribeClusterCommand({ name: clusterName });
      const cluster = await eksClient.send(describeCommand);

      if (cluster.cluster?.status !== 'ACTIVE') continue;

      // Check for node count via CloudWatch
      const nodeCount = await getCloudWatchMetric(
        cwClient, 'ContainerInsights', 'cluster_node_count',
        [{ Name: 'ClusterName', Value: clusterName }],
        dateRange
      );

      if (nodeCount >= 0 && nodeCount === 0) {
        unusedResources.push({
          service: 'Amazon EKS',
          resourceId: cluster.cluster?.arn || clusterName,
          resourceName: clusterName,
          region,
          cost: 0,
          reason: 'No nodes in cluster',
        });
        continue;
      }

      // Check CPU utilization if Container Insights is enabled
      const cpuAvg = await getCloudWatchMetric(
        cwClient, 'ContainerInsights', 'cluster_cpu_utilization',
        [{ Name: 'ClusterName', Value: clusterName }],
        dateRange
      );

      if (cpuAvg >= 0 && cpuAvg < CPU_THRESHOLD) {
        unusedResources.push({
          service: 'Amazon EKS',
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
  dateRange: DateRange
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const ecsClient = new ECSClient({ region });
  const cwClient = new CloudWatchClient({ region });

  try {
    const listCommand = new ECSListClustersCommand({});
    const listResponse = await ecsClient.send(listCommand);

    for (const clusterArn of listResponse.clusterArns || []) {
      const clusterName = clusterArn.split('/').pop() || '';

      // List services in the cluster
      const servicesCommand = new ListServicesCommand({ cluster: clusterArn });
      const servicesResponse = await ecsClient.send(servicesCommand);

      if (!servicesResponse.serviceArns || servicesResponse.serviceArns.length === 0) {
        unusedResources.push({
          service: 'Amazon ECS',
          resourceId: clusterArn,
          resourceName: clusterName,
          region,
          cost: 0,
          reason: 'No services in cluster',
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
            service: 'Amazon ECS',
            resourceId: service.serviceArn || '',
            resourceName: service.serviceName || '',
            region,
            cost: 0,
            reason: 'No running tasks',
          });
        } else if (service.runningCount && service.runningCount > 0) {
          // Check CPU utilization for running services
          const cpuAvg = await getCloudWatchMetric(
            cwClient, 'AWS/ECS', 'CPUUtilization',
            [
              { Name: 'ClusterName', Value: clusterName },
              { Name: 'ServiceName', Value: service.serviceName || '' },
            ],
            dateRange
          );

          if (cpuAvg >= 0 && cpuAvg < CPU_THRESHOLD) {
            unusedResources.push({
              service: 'Amazon ECS',
              resourceId: service.serviceArn || '',
              resourceName: service.serviceName || '',
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
  dateRange: DateRange
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const elasticacheClient = new ElastiCacheClient({ region });
  const cwClient = new CloudWatchClient({ region });

  try {
    const command = new DescribeCacheClustersCommand({});
    const response = await elasticacheClient.send(command);

    for (const cluster of response.CacheClusters || []) {
      if (cluster.CacheClusterStatus !== 'available') continue;

      const clusterId = cluster.CacheClusterId || '';

      // Check current connections
      const connections = await getCloudWatchMetric(
        cwClient, 'AWS/ElastiCache', 'CurrConnections',
        [{ Name: 'CacheClusterId', Value: clusterId }],
        dateRange
      );

      if (connections >= 0 && connections < CONNECTIONS_THRESHOLD) {
        unusedResources.push({
          service: 'Amazon ElastiCache',
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
        cwClient, 'AWS/ElastiCache', 'CPUUtilization',
        [{ Name: 'CacheClusterId', Value: clusterId }],
        dateRange
      );

      if (cpuAvg >= 0 && cpuAvg < CPU_THRESHOLD) {
        unusedResources.push({
          service: 'Amazon ElastiCache',
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
  dateRange: DateRange
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const redshiftClient = new RedshiftClient({ region });
  const cwClient = new CloudWatchClient({ region });

  try {
    const command = new RedshiftDescribeClustersCommand({});
    const response = await redshiftClient.send(command);

    for (const cluster of response.Clusters || []) {
      if (cluster.ClusterStatus !== 'available') continue;

      const clusterId = cluster.ClusterIdentifier || '';

      // Check database connections
      const connections = await getCloudWatchMetric(
        cwClient, 'AWS/Redshift', 'DatabaseConnections',
        [{ Name: 'ClusterIdentifier', Value: clusterId }],
        dateRange
      );

      if (connections >= 0 && connections < CONNECTIONS_THRESHOLD) {
        unusedResources.push({
          service: 'Amazon Redshift',
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
        cwClient, 'AWS/Redshift', 'CPUUtilization',
        [{ Name: 'ClusterIdentifier', Value: clusterId }],
        dateRange
      );

      if (cpuAvg >= 0 && cpuAvg < CPU_THRESHOLD) {
        unusedResources.push({
          service: 'Amazon Redshift',
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
  dateRange: DateRange
): Promise<UnusedResource[]> {
  const unusedResources: UnusedResource[] = [];
  const opensearchClient = new OpenSearchClient({ region });
  const cwClient = new CloudWatchClient({ region });

  try {
    const listCommand = new ListDomainNamesCommand({});
    const listResponse = await opensearchClient.send(listCommand);

    for (const domain of listResponse.DomainNames || []) {
      const domainName = domain.DomainName || '';

      const describeCommand = new DescribeDomainCommand({ DomainName: domainName });
      const domainInfo = await opensearchClient.send(describeCommand);

      if (!domainInfo.DomainStatus?.Created) continue;

      // Check search requests
      const searchRate = await getCloudWatchSumMetric(
        cwClient, 'AWS/ES', 'SearchRate',
        [
          { Name: 'DomainName', Value: domainName },
          { Name: 'ClientId', Value: domainInfo.DomainStatus?.DomainId?.split('/')[0] || '' },
        ],
        dateRange
      );

      if (searchRate >= 0 && searchRate === 0) {
        unusedResources.push({
          service: 'Amazon OpenSearch',
          resourceId: domainInfo.DomainStatus?.ARN || domainName,
          resourceName: domainName,
          region,
          cost: 0,
          reason: 'No search requests',
        });
        continue;
      }

      // Check CPU utilization
      const cpuAvg = await getCloudWatchMetric(
        cwClient, 'AWS/ES', 'CPUUtilization',
        [
          { Name: 'DomainName', Value: domainName },
          { Name: 'ClientId', Value: domainInfo.DomainStatus?.DomainId?.split('/')[0] || '' },
        ],
        dateRange
      );

      if (cpuAvg >= 0 && cpuAvg < CPU_THRESHOLD) {
        unusedResources.push({
          service: 'Amazon OpenSearch',
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

export async function detectUnusedResources(
  dateRange: DateRange
): Promise<UnusedResource[]> {
  console.log('Detecting unused resources across all regions...');
  const allUnusedResources: UnusedResource[] = [];

  // Process regions in parallel batches to avoid rate limiting
  const batchSize = 4;
  for (let i = 0; i < AWS_REGIONS.length; i += batchSize) {
    const batch = AWS_REGIONS.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (region) => {
        console.log(`Checking region: ${region}`);
        const results: UnusedResource[] = [];

        // Run all checks in parallel for each region
        const [
          ec2Results,
          ebsResults,
          rdsResults,
          elbResults,
          eipResults,
          natResults,
          efsResults,
          eksResults,
          ecsResults,
          elasticacheResults,
          redshiftResults,
          opensearchResults,
        ] = await Promise.all([
          checkEC2Instances(region, dateRange),
          checkEBSVolumes(region, dateRange),
          checkRDSInstances(region, dateRange),
          checkLoadBalancers(region, dateRange),
          checkElasticIPs(region),
          checkNATGateways(region, dateRange),
          checkEFSFileSystems(region, dateRange),
          checkEKSClusters(region, dateRange),
          checkECSClusters(region, dateRange),
          checkElastiCacheClusters(region, dateRange),
          checkRedshiftClusters(region, dateRange),
          checkOpenSearchDomains(region, dateRange),
        ]);

        results.push(
          ...ec2Results, ...ebsResults, ...rdsResults, ...elbResults,
          ...eipResults, ...natResults, ...efsResults, ...eksResults,
          ...ecsResults, ...elasticacheResults, ...redshiftResults, ...opensearchResults
        );
        return results;
      })
    );

    allUnusedResources.push(...batchResults.flat());
  }

  console.log(`Found ${allUnusedResources.length} potentially unused resources`);
  return allUnusedResources;
}
