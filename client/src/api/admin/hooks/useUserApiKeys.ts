import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authClient } from "../../../lib/auth";
import { useStripeSubscription } from "../../../lib/subscription/useStripeSubscription";

// List all API keys for the current user
export const useListApiKeys = () => {
  return useQuery({
    queryKey: ["userApiKeys"],
    queryFn: async () => {
      const response = await authClient.apiKey.list();
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
  });
};

// Create a new API key
export const useCreateApiKey = () => {
  const queryClient = useQueryClient();

  const { data: subscription } = useStripeSubscription();

  return useMutation({
    mutationFn: async (data: { name: string; expiresIn?: number }) => {
      const response = await authClient.apiKey.create({
        name: data.name,
        expiresIn: data.expiresIn,
        rateLimitEnabled: true,
        rateLimitTimeWindow: 60 * 1000, // 1 minute
        rateLimitMax: subscription?.planName.includes("pro") ? 100 : 20, // 100 req/min for pro, 20 req/min for standard
      });
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["userApiKeys"] });
    },
  });
};

// Delete an API key
export const useDeleteApiKey = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (keyId: string) => {
      const response = await authClient.apiKey.delete({
        keyId,
      });
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["userApiKeys"] });
    },
  });
};
