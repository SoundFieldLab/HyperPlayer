import { create } from 'zustand';
import type { CenterTask } from '../../services/TaskCenter';

export interface TasksSlice {
  tasks: CenterTask[];
  setTasks(tasks: CenterTask[]): void;
}

export const createTasksSlice = (
  set: (partial: Partial<TasksSlice> | ((state: TasksSlice) => Partial<TasksSlice>)) => void,
): TasksSlice => ({
  tasks: [],
  setTasks: (tasks) => set(() => ({ tasks })),
});

export const useTasksStore = create<TasksSlice>()((set) => createTasksSlice(set));
