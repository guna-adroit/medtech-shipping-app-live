import { useState } from "react";
import { useActionData, useLoaderData, useSubmit } from "react-router";
import { authenticate } from "../shopify.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query getCarrierServices {
        carrierServices(first: 10) {
          edges {
            node {
              id
              name
              active
              callbackUrl
              supportsServiceDiscovery
            }
          }
        }
      }
    `
  );

  const data = await response.json();
  
  return {
    carrierServices: data.data?.carrierServices?.edges || [],
    appUrl: process.env.SHOPIFY_APP_URL || new URL(request.url).origin,
  };
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const action = formData.get("action");

  try {
    if (action === "create") {
      const name = formData.get("name");
      const callbackUrl = formData.get("callbackUrl");

      const response = await admin.graphql(
        `#graphql
          mutation carrierServiceCreate($input: DeliveryCarrierServiceCreateInput!) {
            carrierServiceCreate(input: $input) {
              carrierService {
                id
                name
                active
                callbackUrl
                supportsServiceDiscovery
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          variables: {
            input: {
              name: name,
              callbackUrl: callbackUrl,
              active: true,
              supportsServiceDiscovery: true,
            },
          },
        }
      );

      const data = await response.json();
      
      if (data.data?.carrierServiceCreate?.userErrors?.length > 0) {
        return {
          error: data.data.carrierServiceCreate.userErrors[0].message,
        };
      }

      return {
        success: "Carrier service created successfully!",
        carrierService: data.data?.carrierServiceCreate?.carrierService,
      };
    }

    if (action === "delete") {
      const id = formData.get("id");

      const response = await admin.graphql(
        `#graphql
          mutation carrierServiceDelete($id: ID!) {
            carrierServiceDelete(id: $id) {
              deletedId
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          variables: { id },
        }
      );

      const data = await response.json();

      if (data.data?.carrierServiceDelete?.userErrors?.length > 0) {
        return {
          error: data.data.carrierServiceDelete.userErrors[0].message,
        };
      }

      return { success: "Carrier service deleted successfully!" };
    }

    if (action === "toggle") {
      const id = formData.get("id");
      const active = formData.get("active") === "true";

      const response = await admin.graphql(
        `#graphql
          mutation carrierServiceUpdate($id: ID!, $input: DeliveryCarrierServiceUpdateInput!) {
            carrierServiceUpdate(id: $id, input: $input) {
              carrierService {
                id
                active
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          variables: {
            id,
            input: { active: !active },
          },
        }
      );

      const data = await response.json();

      if (data.data?.carrierServiceUpdate?.userErrors?.length > 0) {
        return {
          error: data.data.carrierServiceUpdate.userErrors[0].message,
        };
      }

      return { success: "Carrier service updated successfully!" };
    }
  } catch (error) {
    return { error: error.message };
  }

  return { error: "Invalid action" };
}

export default function CarrierService() {
  const { carrierServices, appUrl } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();

  const [serviceName, setServiceName] = useState("Custom Shipping Rates");
  const callbackUrl = `${appUrl}/api/carrier-service-callback`;

  const handleCreateService = () => {
    const formData = new FormData();
    formData.append("action", "create");
    formData.append("name", serviceName);
    formData.append("callbackUrl", callbackUrl);
    submit(formData, { method: "post" });
  };

  const handleDeleteService = (id) => {
    if (confirm("Are you sure you want to delete this carrier service?")) {
      const formData = new FormData();
      formData.append("action", "delete");
      formData.append("id", id);
      submit(formData, { method: "post" });
    }
  };

  const handleToggleActive = (id, active) => {
    const formData = new FormData();
    formData.append("action", "toggle");
    formData.append("id", id);
    formData.append("active", active.toString());
    submit(formData, { method: "post" });
  };

  return (
    <s-page title="Carrier Service Setup">
      <s-text slot="subtitle">Manage custom shipping rates for checkout</s-text>

      {actionData?.error && (
        <s-banner tone="critical" title="Error">
          <s-paragraph>{actionData.error}</s-paragraph>
        </s-banner>
      )}

      {actionData?.success && (
        <s-banner tone="success" title="Success">
          <s-paragraph>{actionData.success}</s-paragraph>
        </s-banner>
      )}

      <s-section>
        <s-stack direction="vertical" gap="base">
          <s-heading level="2">Create New Carrier Service</s-heading>

          <s-text-field
            label="Service Name"
            value={serviceName}
            onInput={(e) => setServiceName(e.target.value)}
            placeholder="Custom Shipping Rates"
          />

          <s-text-field
            label="Callback URL"
            value={callbackUrl}
            disabled
            help-text="This is the endpoint that Shopify will call to get shipping rates"
          />

          <s-stack direction="horizontal" alignment="end">
            <s-button variant="primary" onClick={handleCreateService}>
              Create Carrier Service
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section>
        <s-stack direction="vertical" gap="base">
          <s-heading level="2">Existing Carrier Services</s-heading>

          {carrierServices.length === 0 ? (
            <s-text tone="subdued">
              No carrier services found. Create one to get started.
            </s-text>
          ) : (
            <s-stack direction="vertical" gap="300">
              {carrierServices.map(({ node }) => (
                <s-box
                  key={node.id}
                  padding="400"
                  border-width="100"
                  border-radius="200"
                >
                  <s-stack direction="vertical" gap="300">
                    <s-stack direction="horizontal" alignment="space-between" block-alignment="center">
                      <s-stack direction="horizontal" gap="200" block-alignment="center">
                        <s-heading level="3">{node.name}</s-heading>
                        <s-badge tone={node.active ? "success" : "neutral"}>
                          {node.active ? "Active" : "Inactive"}
                        </s-badge>
                      </s-stack>
                      <s-stack direction="horizontal" gap="200">
                        <s-button
                          onClick={() => handleToggleActive(node.id, node.active)}
                        >
                          {node.active ? "Deactivate" : "Activate"}
                        </s-button>
                        <s-button
                          variant="plain"
                          tone="critical"
                          onClick={() => handleDeleteService(node.id)}
                        >
                          Delete
                        </s-button>
                      </s-stack>
                    </s-stack>

                    <s-stack direction="vertical" gap="200">
                      <s-text tone="subdued">
                        <strong>Callback URL:</strong> {node.callbackUrl}
                      </s-text>
                      <s-text tone="subdued">
                        <strong>Service Discovery:</strong> {node.supportsServiceDiscovery ? "Enabled" : "Disabled"}
                      </s-text>
                    </s-stack>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}