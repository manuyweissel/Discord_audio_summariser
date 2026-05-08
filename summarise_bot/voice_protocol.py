from __future__ import annotations

import asyncio

import discord
from discord.voice_client import VoiceProtocol


class GatewayVoiceStateProtocol(VoiceProtocol):
    def __init__(self, client: discord.Client, channel: discord.abc.Connectable) -> None:
        super().__init__(client, channel)
        self.session_id: str | None = None
        self.token: str | None = None
        self.endpoint: str | None = None
        self.server_id: int | None = None
        self.self_mute = True
        self.self_deaf = False
        self._voice_state_complete = asyncio.Event()
        self._voice_server_complete = asyncio.Event()
        self._disconnecting = False

    async def on_voice_state_update(self, data) -> None:
        self.session_id = data["session_id"]
        channel_id = data["channel_id"]
        if self._disconnecting and channel_id is None:
            self._voice_state_complete.set()
            return
        if channel_id is None:
            await self.disconnect(force=True)
            return
        guild = self.channel.guild
        if guild is not None:
            self.channel = guild.get_channel(int(channel_id)) or self.channel
        self._voice_state_complete.set()

    async def on_voice_server_update(self, data) -> None:
        token = data.get("token")
        endpoint = data.get("endpoint")
        if token is None or endpoint is None:
            return
        self.token = token
        self.endpoint = endpoint.removeprefix("wss://")
        self.server_id = int(data["guild_id"])
        self._voice_server_complete.set()

    async def connect(self, *, timeout: float, reconnect: bool) -> None:
        del reconnect
        self._voice_state_complete.clear()
        self._voice_server_complete.clear()
        await self.channel.guild.change_voice_state(
            channel=self.channel,
            self_mute=self.self_mute,
            self_deaf=self.self_deaf,
        )
        await asyncio.wait_for(
            asyncio.gather(
                self._voice_state_complete.wait(),
                self._voice_server_complete.wait(),
            ),
            timeout=timeout,
        )

    async def disconnect(self, *, force: bool) -> None:
        del force
        try:
            if getattr(self.channel, "guild", None) is not None:
                self._disconnecting = True
                await self.channel.guild.change_voice_state(channel=None)
        finally:
            self.cleanup()

    def export_session(self, bot_user_id: int) -> dict[str, object]:
        if not self.session_id or not self.token or not self.endpoint or self.server_id is None:
            raise RuntimeError("Voice gateway session is not ready")
        return {
            "sessionId": f"{self.server_id}:{self.channel.id}",
            "guildId": str(self.server_id),
            "channelId": str(self.channel.id),
            "botUserId": str(bot_user_id),
            "voiceEndpoint": self.endpoint,
            "voiceToken": self.token,
            "voiceSessionId": self.session_id,
            "selfMute": self.self_mute,
            "selfDeaf": self.self_deaf,
        }
