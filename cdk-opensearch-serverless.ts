// @ts-nocheck
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as opensearchserverless from "aws-cdk-lib/aws-opensearchserverless";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

export class Ddb2AossStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const alias = "ryu";

    // DynamoDB
    const table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Lambda用IAM Role
    const ddbToAossFnRole = new iam.Role(this, "DdbToAossFnRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaDynamoDBExecutionRole"
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaVPCAccessExecutionRole"
        ),
      ],
    });
    const aossClientFnRole = new iam.Role(this, "AossClientFnRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaVPCAccessExecutionRole"
        ),
      ],
    });

    // ネットワーク
    const vpc = new ec2.Vpc(this, "Vpc");

    const aossSg = new ec2.SecurityGroup(this, "Sg", {
      vpc: vpc,
    });
    const fnSg = new ec2.SecurityGroup(this, "FnSg", {
      vpc: vpc,
    });
    aossSg.addIngressRule(
      ec2.Peer.securityGroupId(fnSg.securityGroupId),
      ec2.Port.allTcp()
    );

    // 踏み台
    new ec2.BastionHostLinux(this, "BastionHost", {
      vpc,
    });

    // OpenSearch Serverless
    const user = new iam.User(this, "User", { userName: alias });
    new opensearchserverless.CfnAccessPolicy(this, "AccessPolicy", {
      name: alias,
      type: "data",
      policy: ` [{"Description":"Allow access","Rules":[{"ResourceType":"index","Resource":["index/*/*"],"Permission":["aoss:*"]},
        {"ResourceType":"collection","Resource":["collection/${alias}"],"Permission":["aoss:*"]}],
        "Principal":["${user.userArn}","${ddbToAossFnRole.roleArn}","${aossClientFnRole.roleArn}"]}]`,
    });
    const vpcEndpoint = new opensearchserverless.CfnVpcEndpoint(
      this,
      "VpcEndpoint",
      {
        name: alias,
        subnetIds: vpc.privateSubnets.map((subnet) => subnet.subnetId),
        securityGroupIds: [aossSg.securityGroupId],
        vpcId: vpc.vpcId,
      }
    );
    const networkPolicy = new opensearchserverless.CfnSecurityPolicy(
      this,
      "NetworkPolicy",
      {
        name: alias,
        type: "network",
        policy: `[{"Rules":[{"ResourceType":"collection","Resource":["collection/${alias}"]}, {"ResourceType":"dashboard","Resource":["collection/${alias}"]}],"AllowFromPublic":false,"SourceVPCEs":["${vpcEndpoint.attrId}"]}]`,
      }
    );
    networkPolicy.addDependsOn(vpcEndpoint);
    const securityPolicy = new opensearchserverless.CfnSecurityPolicy(
      this,
      "SecurityPolicy",
      {
        name: alias,
        type: "encryption",
        policy: `{"Rules":[{"ResourceType":"collection","Resource":["collection/${alias}"]}],"AWSOwnedKey":true}`,
      }
    );
    const collection = new opensearchserverless.CfnCollection(
      this,
      "Collection",
      {
        name: alias,
        type: "SEARCH",
        description: "search collection",
      }
    );
    collection.addDependsOn(securityPolicy);

    // Lambda関数
    const ddbToAossFn = new NodejsFunction(this, "DdbToAossFn", {
      runtime: lambda.Runtime.NODEJS_18_X,
      role: ddbToAossFnRole,
      entry: "lib/ddb-to-aoss-arch/lambda/ddb-to-aoss/index.ts",
      timeout: cdk.Duration.seconds(10),
      environment: {
        AOSS_ENDPOINT: collection.attrCollectionEndpoint,
      },
      vpc,
      securityGroups: [fnSg],
    });
    ddbToAossFn.addEventSourceMapping("EventSourceMapping", {
      eventSourceArn: table.tableStreamArn,
      enabled: true,
      batchSize: 1,
      startingPosition: lambda.StartingPosition.LATEST,
    });
    const aossClientFn = new NodejsFunction(this, "AossClientFn", {
      runtime: lambda.Runtime.NODEJS_18_X,
      role: aossClientFnRole,
      entry: "lib/ddb-to-aoss-arch/lambda/aoss-client/index.ts",
      timeout: cdk.Duration.seconds(10),
      environment: {
        AOSS_ENDPOINT: collection.attrCollectionEndpoint,
      },
      vpc,
      securityGroups: [fnSg],
    });
  }
}
