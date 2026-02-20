/* tslint:disable */
/* eslint-disable */
// this is an auto generated file. This will be overwritten

import * as APITypes from "../API";
type GeneratedSubscription<InputType, OutputType> = string & {
  __generatedSubscriptionInput: InputType;
  __generatedSubscriptionOutput: OutputType;
};

export const receiveMessages = /* GraphQL */ `subscription ReceiveMessages($sessionId: String) {
  receiveMessages(sessionId: $sessionId) {
    data
    sessionId
    userId
    __typename
  }
}
` as GeneratedSubscription<
  APITypes.ReceiveMessagesSubscriptionVariables,
  APITypes.ReceiveMessagesSubscription
>;
export const receiveUpdateNotification = /* GraphQL */ `subscription ReceiveUpdateNotification($agentName: String!) {
  receiveUpdateNotification(agentName: $agentName) {
    agentName
    __typename
  }
}
` as GeneratedSubscription<
  APITypes.ReceiveUpdateNotificationSubscriptionVariables,
  APITypes.ReceiveUpdateNotificationSubscription
>;
