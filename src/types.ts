export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface DeviceIdentity {
    udid: string;
    name: string;
    osVersion?: string;
    productType?: string;
}
