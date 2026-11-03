import type {
  TemuProduct,
  Listing,
  Sale,
  DashboardData,
  ApiResponse,
  CreateListingRequest,
  AddTrackingRequest,
} from "../../packages/shared/src/types";
import { config } from "./config";

async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  try {
    const res = await fetch(`${config.apiBaseUrl}${path}`, {
      headers: { "Content-Type": "application/json", ...options.headers },
      ...options,
    });
    const body = await res.json();
    return body as ApiResponse<T>;
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function fetchTemuProduct(
  temuUrl: string
): Promise<ApiResponse<TemuProduct>> {
  return apiFetch<TemuProduct>("/api/products/fetch", {
    method: "POST",
    body: JSON.stringify({ temuUrl }),
  });
}

export async function createListing(
  req: CreateListingRequest
): Promise<ApiResponse<Listing>> {
  return apiFetch<Listing>("/api/listings", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function getDashboard(): Promise<ApiResponse<DashboardData>> {
  return apiFetch<DashboardData>("/api/dashboard");
}

export async function getLeboncoinAccounts(): Promise<
  ApiResponse<Array<{ accountId: string; label: string }>>
> {
  return apiFetch("/api/accounts/leboncoin");
}

export async function addTracking(
  saleId: string,
  req: AddTrackingRequest
): Promise<ApiResponse<Sale>> {
  return apiFetch<Sale>(`/api/sales/${saleId}/tracking`, {
    method: "PATCH",
    body: JSON.stringify(req),
  });
}

export async function getSale(saleId: string): Promise<ApiResponse<Sale>> {
  return apiFetch<Sale>(`/api/sales/${saleId}`);
}

export async function getActiveSales(): Promise<ApiResponse<Sale[]>> {
  return apiFetch<Sale[]>("/api/sales?status=active");
}
