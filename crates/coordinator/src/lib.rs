use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WasmAgentConfig {
    pub id: String,
    pub name: String,
    pub role: String,
    pub system_prompt: String,
    pub color: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WasmAgentState {
    pub config: WasmAgentConfig,
    pub status: String,
    pub message_count: u32,
    pub unread_count: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WasmMessage {
    pub id: String,
    pub from_agent: String,
    pub to_agent: String,
    pub content: String,
    pub message_type: String,
    pub timestamp: f64,
    pub round: u32,
}

#[wasm_bindgen]
pub struct Coordinator {
    agents: HashMap<String, WasmAgentState>,
    messages: Vec<WasmMessage>,
    task: Option<String>,
    is_running: bool,
    message_counter: u64,
    // tracks how many messages each agent has "seen" (processed by JS)
    agent_read_counts: HashMap<String, usize>,
}

#[wasm_bindgen]
impl Coordinator {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Coordinator {
        console_error_panic_hook::set_once();
        Coordinator {
            agents: HashMap::new(),
            messages: Vec::new(),
            task: None,
            is_running: false,
            message_counter: 0,
            agent_read_counts: HashMap::new(),
        }
    }

    pub fn add_agent(&mut self, config_json: &str) -> Result<String, JsValue> {
        let config: WasmAgentConfig = serde_json::from_str(config_json)
            .map_err(|e| JsValue::from_str(&format!("parse error: {}", e)))?;
        let id = config.id.clone();
        self.agents.insert(
            id.clone(),
            WasmAgentState {
                config,
                status: "idle".to_string(),
                message_count: 0,
                unread_count: 0,
            },
        );
        self.agent_read_counts.insert(id.clone(), 0);
        Ok(id)
    }

    pub fn remove_agent(&mut self, id: &str) {
        self.agents.remove(id);
        self.agent_read_counts.remove(id);
    }

    pub fn get_agents_json(&self) -> String {
        let mut agents: Vec<&WasmAgentState> = self.agents.values().collect();
        agents.sort_by(|a, b| a.config.id.cmp(&b.config.id));
        serde_json::to_string(&agents).unwrap_or_else(|_| "[]".to_string())
    }

    /// Route a message through the coordinator. Returns the assigned message ID.
    pub fn route_message(&mut self, msg_json: &str) -> Result<String, JsValue> {
        let mut msg: WasmMessage = serde_json::from_str(msg_json)
            .map_err(|e| JsValue::from_str(&format!("parse error: {}", e)))?;

        // Use caller-supplied ID (e.g. UUID) if provided; otherwise fall back to counter
        let id = if msg.id.is_empty() {
            self.message_counter += 1;
            format!("msg_{}", self.message_counter)
        } else {
            msg.id.clone()
        };
        msg.id = id.clone();

        // Increment sender's outgoing count
        if let Some(agent) = self.agents.get_mut(&msg.from_agent) {
            agent.message_count += 1;
        }

        // Increment recipient's unread count (if it's a named agent)
        if msg.to_agent != "user" && msg.to_agent != "broadcast" {
            if let Some(agent) = self.agents.get_mut(&msg.to_agent) {
                agent.unread_count += 1;
            }
        }

        self.messages.push(msg);
        Ok(id)
    }

    /// Get all messages directed at a specific agent (or broadcast).
    pub fn get_messages_for(&self, agent_id: &str) -> String {
        let msgs: Vec<&WasmMessage> = self.messages.iter()
            .filter(|m| m.to_agent == agent_id || m.to_agent == "broadcast")
            .collect();
        serde_json::to_string(&msgs).unwrap_or_else(|_| "[]".to_string())
    }

    /// Get the number of messages directed at an agent (for detecting new ones).
    pub fn get_message_count_for(&self, agent_id: &str) -> u32 {
        self.messages.iter()
            .filter(|m| m.to_agent == agent_id || m.to_agent == "broadcast")
            .count() as u32
    }

    /// Get all messages in the session (for the activity monitor).
    pub fn get_all_messages_json(&self) -> String {
        serde_json::to_string(&self.messages).unwrap_or_else(|_| "[]".to_string())
    }

    pub fn update_agent_status(&mut self, agent_id: &str, status: &str) {
        if let Some(agent) = self.agents.get_mut(agent_id) {
            agent.status = status.to_string();
        }
    }

    pub fn get_agent_status(&self, agent_id: &str) -> String {
        self.agents.get(agent_id)
            .map(|a| a.status.clone())
            .unwrap_or_else(|| "unknown".to_string())
    }

    pub fn set_task(&mut self, task: &str) {
        self.task = Some(task.to_string());
    }

    pub fn set_running(&mut self, running: bool) {
        self.is_running = running;
    }

    pub fn is_running(&self) -> bool {
        self.is_running
    }

    pub fn agent_count(&self) -> usize {
        self.agents.len()
    }

    pub fn message_count(&self) -> usize {
        self.messages.len()
    }

    /// Reset all messages, statuses, and unread counts for a new session.
    pub fn clear_session(&mut self) {
        self.messages.clear();
        self.message_counter = 0;
        self.task = None;
        self.is_running = false;
        for agent in self.agents.values_mut() {
            agent.status = "idle".to_string();
            agent.message_count = 0;
            agent.unread_count = 0;
        }
        for count in self.agent_read_counts.values_mut() {
            *count = 0;
        }
    }

    /// Get a summary of the current coordinator state as JSON.
    pub fn get_state_json(&self) -> String {
        let mut agents: Vec<&WasmAgentState> = self.agents.values().collect();
        agents.sort_by(|a, b| a.config.id.cmp(&b.config.id));
        let state = serde_json::json!({
            "agents": agents,
            "message_count": self.messages.len(),
            "task": self.task,
            "is_running": self.is_running,
        });
        state.to_string()
    }
}
