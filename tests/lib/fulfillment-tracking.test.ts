import { describe, expect, it } from "vitest";

import {
  FulfillmentTrackingInput,
  FulfillmentTrackingValidationError,
  compileFulfillmentTracking,
  verifyFulfillmentTrackingPacket,
} from "../../lib/fulfillment-tracking";

function input(): FulfillmentTrackingInput {
  return {
    orderId: "order-42",
    carrierCode: "ups",
    carrierName: "UPS",
    trackingNumber: "1Z 999 AA1 01 2345 6784",
    shippedAt: "2026-09-14T01:40:00.000Z",
    expectedDeliveryAt: "2026-09-17T21:00:00.000Z",
    trackingUrl: "https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784",
  };
}

const PREPARED_AT = "2026-09-14T01:42:00.000Z";

describe("fulfillment tracking receipt compiler", () => {
  it("canonicalizes merchant tracking evidence without granting commerce authority", async () => {
    const packet = await compileFulfillmentTracking(input(), PREPARED_AT);

    expect(packet.record.carrierCode).toBe("UPS");
    expect(packet.receipt.recordDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(packet.receipt).toMatchObject({
      merchantAttestationOnly: true,
      carrierDeliveryVerified: false,
      dispatchAuthorized: false,
      refundAuthorized: false,
      paymentAuthorized: false,
      inventoryMutationAuthorized: false,
    });
  });

  it("is deterministic for exact replay and detects record tampering", async () => {
    const first = await compileFulfillmentTracking(input(), PREPARED_AT);
    const replay = await compileFulfillmentTracking(structuredClone(input()), PREPARED_AT);
    expect(replay).toEqual(first);
    await expect(verifyFulfillmentTrackingPacket(first)).resolves.toBe(true);

    const tampered = structuredClone(first);
    tampered.record.trackingNumber = "DIFFERENT";
    await expect(verifyFulfillmentTrackingPacket(tampered)).resolves.toBe(false);
  });

  it("rejects insecure or credential-bearing tracking URLs", async () => {
    for (const trackingUrl of [
      "http://carrier.example/track",
      "https://user:pass@carrier.example/track",
      "https://carrier.example/track#private-fragment",
    ]) {
      const source = input();
      source.trackingUrl = trackingUrl;
      await expect(compileFulfillmentTracking(source, PREPARED_AT)).rejects.toBeInstanceOf(
        FulfillmentTrackingValidationError
      );
    }
  });

  it("rejects malformed identifiers, control characters and non-canonical timestamps", async () => {
    const badCode = input();
    badCode.carrierCode = "bad carrier!";
    await expect(compileFulfillmentTracking(badCode, PREPARED_AT)).rejects.toBeInstanceOf(
      FulfillmentTrackingValidationError
    );

    const control = input();
    control.trackingNumber = "TRACK\nINJECT";
    await expect(compileFulfillmentTracking(control, PREPARED_AT)).rejects.toBeInstanceOf(
      FulfillmentTrackingValidationError
    );

    const offset = input();
    offset.shippedAt = "2026-09-13T21:40:00-04:00";
    await expect(compileFulfillmentTracking(offset, PREPARED_AT)).rejects.toThrow(
      "canonical UTC"
    );
  });

  it("rejects implausible future shipment and delivery-before-shipment chronology", async () => {
    const future = input();
    future.shippedAt = "2026-09-14T02:00:00.000Z";
    await expect(compileFulfillmentTracking(future, PREPARED_AT)).rejects.toThrow("future");

    const backwards = input();
    backwards.expectedDeliveryAt = "2026-09-13T21:00:00.000Z";
    await expect(compileFulfillmentTracking(backwards, PREPARED_AT)).rejects.toThrow("predates");
  });
});
