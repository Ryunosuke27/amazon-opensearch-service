// @ts-nocheck
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Client } from "@opensearch-project/opensearch/.";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import Event from "./ddb-to-aoss-event.json";

const aossClient = new Client({
  ...AwsSigv4Signer({
    // @ts-ignore
    service: "aoss",
    region: "ap-northeast-1",
    getCredentials: () => {
      const credentialsProvider = defaultProvider();
      return credentialsProvider();
    },
  }),
  node: process.env.AOSS_ENDPOINT,
});
type DbdStreamEvent = typeof Event;

/**
 * DynamoDB → OpenSearch データコピー関数
 *
 * 参考文献
 * https://github.com/opensearch-project/opensearch-js/blob/main/USER_GUIDE.md
 */
export const handler = async (event: DbdStreamEvent) => {
  console.log(JSON.stringify(event));

  // データ形式変換
  const id = event.Records[0].dynamodb.Keys.id.S;

  let response;
  switch (event.Records[0].eventName) {
    case "INSERT":
    case "MODIFY":
      console.log("Upserting document:");
      const body = unmarshall(event.Records[0].dynamodb.NewImage);
      response = await aossClient.index({
        id,
        index: "books",
        body,
      });
      console.log(response.body);
      break;
    case "REMOVE":
      console.log("Deleting document:");
      try {
        response = await aossClient.delete({
          id,
          index: "books",
        });
        console.log(response.body);
      } catch (e: any) {
        if (e.meta.body.result === "not_found") {
          console.log("document not found.");
        } else {
          throw e;
        }
      }
      break;
  }
};
