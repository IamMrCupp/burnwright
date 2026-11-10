import { deviceNotices } from "../../lib/firmware";
import type { DeviceInfo } from "../../lib/engine";
import "./DeviceNotices.css";

export interface DeviceNoticesProps {
  device: DeviceInfo;
}

/**
 * What minipro warned about when it found the programmer: firmware that's
 * out of date (worth acting on) or newer than expected, and its own note on
 * how well it supports the model. Renders nothing when there's nothing to say.
 */
export function DeviceNotices({ device }: DeviceNoticesProps) {
  const notices = deviceNotices(device);
  if (notices.length === 0) return null;
  return (
    <section className="device-notices" aria-label="Notes about this programmer">
      {notices.map((notice) => (
        <article
          key={notice.title}
          className={`device-notice device-notice-${notice.severity}`}
          // A warning is announced; a note isn't worth interrupting for.
          role={notice.severity === "warning" ? "alert" : undefined}
        >
          <h3>
            <span className="device-notice-tag">
              {notice.severity === "warning" ? "Warning" : "Note"}
            </span>{" "}
            {notice.title}
          </h3>
          <p>{notice.detail}</p>
        </article>
      ))}
    </section>
  );
}
