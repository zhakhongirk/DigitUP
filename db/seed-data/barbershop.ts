import type { BusinessModelInput } from "@/shared/business-model";

type Offer = NonNullable<BusinessModelInput["offers"]>[number];

function service(
  title: string,
  description: string,
  category: string,
  minutes: number,
  level: "junior" | "senior" | "master",
  price: number | null,
): Offer {
  return {
    title,
    description,
    category,
    offer_type: "barber_service",
    attributes: { duration_minutes: minutes, barber_level: level },
    price,
    currency: price === null ? null : "KZT",
    price_status: price === null ? "on_request" : "confirmed",
    availability: "in_stock",
    status: "active",
  };
}

export const barbershopModel: BusinessModelInput = {
  profile: {
    name: "Fade Factory Barbershop",
    description:
      "Fade Factory is a barbershop in Almaty offering men's and kids' haircuts, beard care, hot towel shaves, coloring and event styling.",
    category: "Barbershop",
    contacts: {
      phone: "+7 727 244 88 10",
      telegram: "@fadefactory_almaty",
      address: "Dostyk Avenue 118, Almaty",
    },
  },
  offer_types: [
    {
      key: "barber_service",
      name: "Barber service",
      kind: "service",
      attributes: [
        { key: "duration_minutes", label: "Duration", type: "number", unit: "min", required: true },
        {
          key: "barber_level",
          label: "Barber level",
          type: "enum",
          options: ["junior", "senior", "master"],
          required: false,
        },
      ],
    },
  ],
  offers: [
    service(
      "Classic haircut",
      "Scissor or clipper haircut with wash and styling.",
      "Haircuts",
      45,
      "senior",
      7000,
    ),
    service(
      "Skin fade",
      "Precision skin fade with a blended top and finishing line-up.",
      "Haircuts",
      60,
      "master",
      9500,
    ),
    service(
      "Beard trim",
      "Beard shaping and trimming with hot towel and beard oil.",
      "Beard",
      30,
      "senior",
      5000,
    ),
    service(
      "Hot towel shave",
      "Traditional straight-razor shave with hot towels and aftershave balm.",
      "Beard",
      40,
      "master",
      8000,
    ),
    service("Kids haircut", "Haircut for boys up to 12 years old.", "Haircuts", 30, "junior", 5000),
    service("Father and son", "Two haircuts booked back to back.", "Haircuts", 75, "senior", 11500),
    service(
      "Hair coloring",
      "Full coloring or grey blending, including consultation and styling.",
      "Coloring",
      90,
      "master",
      16000,
    ),
    service(
      "Wedding styling",
      "Haircut, beard grooming and styling for the groom. Price depends on the package.",
      "Events",
      120,
      "master",
      null,
    ),
  ],
  policies: {
    delivery: null,
    payment: "Cash, Kaspi QR and bank cards accepted at the shop.",
    returns: null,
    working_hours: "Monday-Saturday 10:00-21:00, Sunday 11:00-19:00.",
    other:
      "Booking by phone or Telegram is recommended. Please cancel at least 3 hours before your appointment; walk-ins are welcome when a chair is free.",
  },
  missing_info: [],
};
