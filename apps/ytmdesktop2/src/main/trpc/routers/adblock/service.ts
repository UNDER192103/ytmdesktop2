import { ElectronBlocker } from "@ghostery/adblocker-electron";
import { BaseProvider, OnDestroy, OnInit } from "@main/core/baseProvider";
import type SettingsProvider from "@main/trpc/routers/settings/service";
import type { Session } from "electron";

/** Applies Ghostery's maintained ad and tracking rules to YouTube Music's session. */
export default class AdblockProvider extends BaseProvider implements OnDestroy, OnInit {
	private blocker: ElectronBlocker | null = null;
	private blockingEnabled = false;
	private syncPromise: Promise<void> | null = null;
	private settingsSubscription: { unsubscribe(): void } | null = null;
	private activeSession: Session | null = null;

	constructor() {
		super("adblock", "Ad blocker");
	}

	/** Prepare the session before YouTube's WebContentsView is created. */
	async prepare(targetSession: Session): Promise<void> {
		try {
			await this.sync(targetSession);
		} catch (error) {
			this.logger.error("Unable to enable ad blocking", error);
		}
 	}

	async OnInit(): Promise<void> {
		await this.prepare(this.views.youtubeView.webContents.session);
		this.settingsSubscription = this.settings.onSettingChange("player.adblock", () => {
			void this.updateSetting();
		});
	}

	async OnDestroy(): Promise<void> {
		this.settingsSubscription?.unsubscribe();
		this.settingsSubscription = null;
		if (this.blocker && this.blockingEnabled && this.activeSession) {
			this.blocker.disableBlockingInSession(this.activeSession);
			this.blockingEnabled = false;
		}
		this.activeSession = null;
	}

	private get settings(): SettingsProvider {
		return this.getProvider("settings");
	}

	private async getBlocker(): Promise<ElectronBlocker> {
		if (!this.blocker) {
			this.logger.debug("Loading ad and tracker blocking rules");
			this.blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(globalThis.fetch);
		}
		return this.blocker;
	}

	private async sync(targetSession: Session): Promise<void> {
		if (this.syncPromise) return this.syncPromise;

		this.syncPromise = this.syncBlocking(targetSession);
		try {
			await this.syncPromise;
		} finally {
			this.syncPromise = null;
		}
	}

	private async syncBlocking(targetSession: Session): Promise<void> {
		if (!this.settings.get("player.adblock", true)) {
			if (this.blocker && this.blockingEnabled && this.activeSession) {
				this.blocker.disableBlockingInSession(this.activeSession);
			}
			this.blockingEnabled = false;
			this.activeSession = null;
			this.logger.debug("Ad blocking disabled");
			return;
		}

		if (this.blockingEnabled && this.activeSession === targetSession) return;
		if (this.blocker && this.blockingEnabled && this.activeSession) {
			this.blocker.disableBlockingInSession(this.activeSession);
			this.blockingEnabled = false;
		}
		const blocker = await this.getBlocker();
		blocker.enableBlockingInSession(targetSession);
		this.blockingEnabled = true;
		this.activeSession = targetSession;
		this.logger.debug("Ad blocking enabled for YouTube Music");
	}

	private async updateSetting(): Promise<void> {
		const view = this.views.youtubeView;
		if (!view || view.webContents.isDestroyed()) return;
		await this.prepare(view.webContents.session);
		// Session preloads only run on document creation. Reload after a manual
		// toggle so cosmetic filters and scriptlets match the new setting.
		view.webContents.reload();
	}
}
