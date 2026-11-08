"use strict";

globalThis.GravelboxBlocklist = {
  defaults: ["x.com", "linkedin.com", "youtube.com", "discord.com", "discord.gg", "discordapp.com", "gmail.com", "mail.google.com", "github.com"].map(domain => ({ domain })),
  delay: 5 * 60 * 1000,
  normalize(value) {
    const input = value.trim();
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Enter a website domain or an http/https URL.");
    }
    const domain = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    if (!domain || (!domain.includes(".") && domain !== "localhost")) {
      throw new Error("Enter a full domain, such as example.com.");
    }
    return domain;
  },
  active(entries, now = Date.now()) {
    return entries.filter(entry => !entry.removeAt || entry.removeAt > now);
  },
  matches(value, entries, now = Date.now()) {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) return false;
      const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
      return this.active(entries, now).some(({ domain }) =>
        hostname === domain || hostname.endsWith(`.${domain}`)
      );
    } catch (_) { return false; }
  }
};
