use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use kosong::tooling::{
    CallableTool2, DisplayBlock, TodoDisplayBlock, TodoDisplayItem, ToolReturnValue,
};

pub struct SetTodoList {
    description: String,
}

impl SetTodoList {
    pub fn new(_runtime: &crate::soul::agent::Runtime) -> Self {
        Self {
            description: include_str!("desc/todo/set_todo_list.md").to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Done,
}

impl TodoStatus {
    fn as_str(&self) -> &'static str {
        match self {
            TodoStatus::Pending => "pending",
            TodoStatus::InProgress => "in_progress",
            TodoStatus::Done => "done",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TodoItem {
    /// The title of the todo.
    #[schemars(description = "The title of the todo", length(min = 1))]
    pub title: String,
    /// The status of the todo.
    #[schemars(description = "The status of the todo")]
    pub status: TodoStatus,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TodoParams {
    /// The updated todo list.
    #[schemars(description = "The updated todo list")]
    pub todos: Vec<TodoItem>,
}

#[async_trait::async_trait]
impl CallableTool2 for SetTodoList {
    type Params = TodoParams;

    fn name(&self) -> &str {
        "SetTodoList"
    }

    fn description(&self) -> &str {
        &self.description
    }

    async fn call_typed(&self, params: Self::Params) -> ToolReturnValue {
        let items = params
            .todos
            .into_iter()
            .map(|todo| TodoDisplayItem {
                title: todo.title,
                status: todo.status.as_str().to_string(),
            })
            .collect();
        ToolReturnValue {
            is_error: false,
            output: "".into(),
            message: "Todo list updated".to_string(),
            display: vec![DisplayBlock::Todo(TodoDisplayBlock::new(items))],
            extras: None,
        }
    }
}
