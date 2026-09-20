import * as v from "valibot";
import type { FixtureRequest } from "./manifest.js";

/** Seed every Community property type while preserving existing definitions and emoji presets. */
export async function metadataFixture(request: FixtureRequest) {
  const properties = [
    {
      id: "parity_text",
      name: "Acceptance text",
      type: "text",
      min: 1,
      max: 64,
    },
    {
      id: "parity_number",
      name: "Acceptance number",
      type: "number",
      min: -5,
      max: 100,
    },
    { id: "parity_boolean", name: "Acceptance boolean", type: "boolean" },
    {
      id: "parity_select",
      name: "Acceptance select",
      type: "select",
      options: ["red", "blue"],
    },
    {
      id: "parity_multi",
      name: "Acceptance multiple",
      type: "multi_select",
      options: ["red", "blue"],
    },
    { id: "parity_link", name: "Acceptance link", type: "link", max: 2048 },
    { id: "parity_rating", name: "Acceptance rating", type: "rating", max: 5 },
  ];

  const saved = v.parse(
    v.record(v.string(), v.string()),
    await request("/api/v4/admin/settings", {
      method: "POST",
      body: JSON.stringify({ keys: ["custom_props", "emojis"] }),
    }),
  );

  const originalProps = saved.custom_props ?? "[]";
  const originalEmoji = saved.emojis ?? "{}";

  const existing = v.parse(v.array(v.looseObject({ id: v.string() })), JSON.parse(originalProps));

  const emojis = v.parse(v.record(v.string(), v.array(v.string())), JSON.parse(originalEmoji));

  const set = async (key: string, value: string) => {
    await request("/api/v4/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({ settings: { [key]: value } }),
    });
  };

  const close = async () => {
    try {
      await set("custom_props", originalProps);
    } finally {
      await set("emojis", originalEmoji);
    }
  };

  try {
    await set(
      "custom_props",
      JSON.stringify([
        ...existing.filter((item) => !properties.some((property) => property.id === item.id)),
        ...properties,
      ]),
    );

    await set("emojis", JSON.stringify({ ...emojis, parity: ["📁", "🎵"] }));

    return { properties, emoji: "📁", close };
  } catch (error) {
    await close();

    throw error;
  }
}
