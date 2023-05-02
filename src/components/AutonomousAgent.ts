import axios from "axios";
import type { ModelSettings } from "../utils/types";
import AgentService from "../services/agent-service";
import {
  // DEFAULT_MAX_LOOPS_FREE,
  DEFAULT_MAX_LOOPS_PAID,
} from "../utils/constants";
// import { env } from "../env/client.mjs";
import { v4, v1 } from "uuid";
import type { RequestBody } from "../utils/interfaces";
import {
  TASK_STATUS_STARTED,
  TASK_STATUS_EXECUTING,
  TASK_STATUS_COMPLETED,
  TASK_STATUS_FINAL,
  MESSAGE_TYPE_TASK,
  MESSAGE_TYPE_GOAL,
  MESSAGE_TYPE_THINKING,
  MESSAGE_TYPE_SYSTEM,
} from "../types/agentTypes";
import type { Message, Task } from "../types/agentTypes";

const TIMEOUT_LONG = 1000;
const TIMOUT_SHORT = 800;

class AutonomousAgent {
  name: string;
  goal: string;
  tasks: Message[] = [];
  completedTasks: string[] = [];
  modelSettings: ModelSettings;
  isRunning = true;
  renderMessage: (message: Message) => void;
  shutdown: () => void;
  numLoops = 0;
  _id: string;

  constructor(
    name: string,
    goal: string,
    renderMessage: (message: Message) => void,
    shutdown: () => void,
    modelSettings: ModelSettings
  ) {
    console.log("AutonomousAgent constructor", modelSettings);
    this.name = name;
    this.goal = goal;
    this.renderMessage = renderMessage;
    this.shutdown = shutdown;
    this.modelSettings = modelSettings;
    this._id = v4();
  }

  async run() {
    this.sendGoalMessage();
    this.sendThinkingMessage();

    // Initialize by getting taskValues
    try {
      const taskValues = await this.getInitialTasks();
      for (const value of taskValues) {
        await new Promise((r) => setTimeout(r, TIMOUT_SHORT));
        const task: Task = {
          taskId: v1().toString(),
          value,
          status: TASK_STATUS_STARTED,
          type: MESSAGE_TYPE_TASK,
        };
        this.sendMessage(task);
        this.tasks.push(task);
      }
    } catch (e) {
      this.sendErrorMessage(getMessageFromError(e));
      this.shutdown();
      return;
    }

    await this.loop();
  }

  async loop() {
    console.log(`Loop ${this.numLoops}`);
    console.log(this.tasks);

    if (!this.isRunning) {
      return;
    }

    if (this.tasks.length === 0) {
      this.sendCompletedMessage();
      this.shutdown();
      return;
    }

    this.numLoops += 1;
    const maxLoops = this.maxLoops();
    if (this.numLoops > maxLoops) {
      this.sendLoopMessage();
      this.shutdown();
      return;
    }

    // Wait before starting
    await new Promise((r) => setTimeout(r, TIMEOUT_LONG));

    // Execute first task
    // Get and remove first task
    this.completedTasks.push(this.tasks[0]?.value || "");

    const currentTask = this.tasks.shift() as Task;
    this.sendThinkingMessage();
    currentTask.status = TASK_STATUS_EXECUTING;
    this.sendMessage(currentTask);

    const result = await this.executeTask(currentTask.value);

    currentTask.status = TASK_STATUS_COMPLETED;
    currentTask.info = result;
    this.sendMessage(currentTask);

    // Wait before adding tasks
    await new Promise((r) => setTimeout(r, TIMEOUT_LONG));
    this.sendThinkingMessage();

    // Add new tasks
    try {
      const newTasks = await this.getAdditionalTasks(currentTask.value, result);
      for (const value of newTasks) {
        await new Promise((r) => setTimeout(r, TIMOUT_SHORT));
        const task: Task = {
          taskId: v1().toString(),
          value,
          status: TASK_STATUS_STARTED,
          type: MESSAGE_TYPE_TASK,
        };
        this.tasks.push(task);
        this.sendMessage(task);
      }

      if (newTasks.length == 0) {
        currentTask.status = TASK_STATUS_FINAL;
        this.sendMessage(currentTask);
      }
    } catch (e) {
      console.log(e);
      this.sendErrorMessage(
        `❌ ERROR adding additional task(s). It might have been against our model's policies to run them. Continuing.`
      );
      currentTask.status = TASK_STATUS_FINAL;
      this.sendMessage(currentTask);
    }

    await this.loop();
  }

  private maxLoops() {
    console.log('max loops', this.modelSettings.customMaxLoops);
    return this.modelSettings.customMaxLoops || DEFAULT_MAX_LOOPS_PAID;
  }

  async getInitialTasks(): Promise<string[]> {
    if (this.shouldRunClientSide()) {
      // if (!env.NEXT_PUBLIC_FF_MOCK_MODE_ENABLED) {
      //   await testConnection(this.modelSettings);
      // }
      return await AgentService.startGoalAgent(this.modelSettings, this.goal);
    }

    const data = {
      modelSettings: this.modelSettings,
      goal: this.goal,
    };
    const res = await this.post(`/api/agent/start`, data);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-argument
    return res.data.newTasks as string[];
  }

  async getAdditionalTasks(
    currentTask: string,
    result: string
  ): Promise<string[]> {
    const taskValues = this.tasks.map((task) => task.value);

    if (this.shouldRunClientSide()) {
      return await AgentService.createTasksAgent(
        this.modelSettings,
        this.goal,
        taskValues,
        currentTask,
        result,
        this.completedTasks
      );
    }

    const data = {
      modelSettings: this.modelSettings,
      goal: this.goal,
      tasks: taskValues,
      lastTask: currentTask,
      result: result,
      completedTasks: this.completedTasks,
    };
    const res = await this.post(`/api/agent/create`, data);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument,@typescript-eslint/no-unsafe-member-access
    return res.data.newTasks as string[];
  }

  async executeTask(task: string): Promise<string> {
    if (this.shouldRunClientSide()) {
      return await AgentService.executeTaskAgent(
        this.modelSettings,
        this.goal,
        task
      );
    }

    const data = {
      modelSettings: this.modelSettings,
      goal: this.goal,
      task: task,
    };
    const res = await this.post("/api/agent/execute", data);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-argument
    return res.data.response as string;
  }

  private async post(url: string, data: RequestBody) {
    try {
      return await axios.post(url, data);
    } catch (e) {
      this.shutdown();

      if (axios.isAxiosError(e) && e.response?.status === 429) {
        this.sendErrorMessage("Rate limit exceeded. Please slow down. 😅");
      }

      throw e;
    }
  }

  private shouldRunClientSide() {
    return true;
  }

  stopAgent() {
    this.sendManualShutdownMessage();
    this.isRunning = false;
    this.shutdown();
    return;
  }

  sendMessage(message: Message) {
    if (this.isRunning) {
      this.renderMessage(message);
    }
  }

  sendGoalMessage() {
    this.sendMessage({ type: MESSAGE_TYPE_GOAL, value: this.goal });
  }

  sendLoopMessage() {
    this.sendMessage({
      type: MESSAGE_TYPE_SYSTEM,
      value:
        "We've cut this session short as it seems the agent has lost track. If this is a mistake, please reach out via Github. Shutting down.",
    });
  }

  sendManualShutdownMessage() {
    this.sendMessage({
      type: MESSAGE_TYPE_SYSTEM,
      value: `The agent has been manually shutdown.`,
    });
  }

  sendCompletedMessage() {
    this.sendMessage({
      type: MESSAGE_TYPE_SYSTEM,
      value: "All tasks completed. Shutting down.",
    });
  }

  sendThinkingMessage() {
    this.sendMessage({ type: MESSAGE_TYPE_THINKING, value: "" });
  }

  sendErrorMessage(error: string) {
    this.sendMessage({ type: MESSAGE_TYPE_SYSTEM, value: error });
  }
}

const getMessageFromError = (e: unknown) => {
  let message =
    "ERROR accessing OpenAI APIs. Please check your API key or try again later";
  if (axios.isAxiosError(e)) {
    const axiosError = e;
    if (axiosError.response?.status === 429) {
      message = `ERROR using your OpenAI API key. You've exceeded your current quota, please check your plan and billing details.`;
    }
    if (axiosError.response?.status === 404) {
      message = `ERROR your API key does not have GPT-4 access. You must first join OpenAI's wait-list. (This is different from ChatGPT Plus)`;
    }
  } else if (
    (e as { message: string }).message ===
    "This browser env do not support WebGPU"
  ) {
    message = `❌ Error initializing the local LLM. Your browser does not support WebGPU. Please retry on Chrome Beta/Canary (see 'Help'). Shutting Down.`;
  } else {
    message = `❌ Error retrieving initial tasks array. Refresh and retry, clarify your goal, or revise your goal such that it is allowed by our model's policies. Error message: ${
      (e as { message: string }).message
    }`;
  }
  return message;
};

export default AutonomousAgent;
